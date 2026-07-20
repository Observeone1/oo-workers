/**
 * Backup export format contract — exportStream (gzip NDJSON), the
 * tar.gz artifact envelope, estimateArtifacts and exportSplit.
 *
 * gzip and tar are NOT mocked: every test decompresses the real bytes
 * the writer produced and parses them back, so the assertions are on
 * the on-disk format a restore actually has to read. Only the two I/O
 * boundaries are faked — the drizzle `db` reads and object storage.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  dbMock,
  mockDb,
  mockObjectStorage,
  objectStorageMock,
  resetObjectStorageMock,
} from '../test-support/shared-mocks.ts';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTableName } from 'drizzle-orm';
import tar from 'tar-stream';
import * as schema from '../db/schema.ts';

type Row = Record<string, unknown>;

/** Rows the fake db returns, keyed by SQL table name. Default: empty. */
const rowsByTable: Record<string, Row[]> = {};

/**
 * A drizzle query stand-in: a real Promise carrying the chain methods, so the
 * builder can be awaited directly without hand-rolling a `then`. The table is
 * known by `.from()`, which is where the rows are resolved.
 */
type Query = Promise<unknown> & {
  where: () => Query;
  orderBy: () => Query;
  limit: () => Query;
};

function selectChain(): { from: (t: unknown) => Query } {
  return {
    from: (t: unknown) => {
      const name = getTableName(t as Parameters<typeof getTableName>[0]);
      // Always the first (and only) page: a short page ends the keyset loop.
      const q = Promise.resolve(rowsByTable[name] ?? []) as Query;
      q.where = () => q;
      q.orderBy = () => q;
      q.limit = () => q;
      return q;
    },
  };
}

const sqlTag = () => Promise.resolve([{ name: '0042_add_regions.sql' }]);

mockDb();
mockObjectStorage();
const { listObjectsWithSize, getObjectResponse } = objectStorageMock;

const { estimateArtifacts, exportSplit, exportStream } = await import('./backup-export.ts');

const REGIONS = getTableName(schema.regions);
const MONITOR_REGIONS = getTableName(schema.monitorRegions);
const URL_EXECS = getTableName(schema.urlMonitorExecutions);

const tmpDirs: string[] = [];

beforeEach(() => {
  for (const k of Object.keys(rowsByTable)) delete rowsByTable[k];
  // Shared registrations: prime our own behaviour every time.
  dbMock.db = { select: () => selectChain() };
  dbMock.sql = sqlTag;
  resetObjectStorageMock();
  getObjectResponse.mockImplementation(async () => new Response('x'));
});

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of Readable.fromWeb(stream as never)) {
    chunks.push(Buffer.from(c as Buffer));
  }
  return Buffer.concat(chunks);
}

/** Decompress an exportStream result into its NDJSON lines. */
async function ndjsonLines(stream: ReadableStream<Uint8Array>): Promise<Row[]> {
  const text = gunzipSync(await readAll(stream)).toString('utf8');
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Row);
}

/** Decompress a tar.gz envelope into { entryName: Buffer }. */
async function tarEntries(stream: ReadableStream<Uint8Array>): Promise<Record<string, Buffer>> {
  const raw = gunzipSync(await readAll(stream));
  const out: Record<string, Buffer> = {};
  const extract = tar.extract();
  await new Promise<void>((done, fail) => {
    extract.on('entry', (header, body, next) => {
      const chunks: Buffer[] = [];
      body.on('data', (d: Buffer) => chunks.push(d));
      body.on('end', () => {
        out[header.name] = Buffer.concat(chunks);
        next();
      });
      body.resume();
    });
    extract.on('finish', () => done());
    extract.on('error', fail);
    extract.end(raw);
  });
  return out;
}

describe('exportStream — gzip NDJSON', () => {
  test('emits a manifest line first, then rows tagged with their table', async () => {
    rowsByTable[REGIONS] = [
      { id: 1, slug: 'eu' },
      { id: 2, slug: 'us' },
    ];

    const lines = await ndjsonLines(exportStream({ scope: 'all', sinceDays: 90 } as never));

    expect(lines[0]).toEqual({
      manifest: {
        format: 1,
        ooVersion: expect.any(String),
        schemaHead: '0042_add_regions.sql',
        createdAt: expect.any(String),
        scope: 'all',
        sinceDays: null,
      },
    });
    expect(lines.slice(1)).toEqual([
      { t: REGIONS, r: { id: 1, slug: 'eu' } },
      { t: REGIONS, r: { id: 2, slug: 'us' } },
    ]);
  });

  test('records the retention window on the manifest in window scope', async () => {
    const lines = await ndjsonLines(exportStream({ scope: 'window', sinceDays: 7 } as never));

    expect((lines[0].manifest as Row).scope).toBe('window');
    expect((lines[0].manifest as Row).sinceDays).toBe(7);
  });

  test('config-only scope drops the execution tables but keeps config ones', async () => {
    rowsByTable[REGIONS] = [{ id: 1 }];
    rowsByTable[URL_EXECS] = [{ id: 500 }];

    const lines = await ndjsonLines(exportStream({ scope: 'none', sinceDays: 90 } as never));
    const tables = lines.slice(1).map((l) => l.t);

    expect(tables).toContain(REGIONS);
    expect(tables).not.toContain(URL_EXECS);
  });

  test('window scope keeps the execution tables', async () => {
    rowsByTable[URL_EXECS] = [{ id: 500 }];

    const lines = await ndjsonLines(exportStream({ scope: 'window', sinceDays: 30 } as never));

    expect(lines.slice(1).map((l) => l.t)).toContain(URL_EXECS);
  });

  test('composite-PK join tables are emitted without paging', async () => {
    rowsByTable[MONITOR_REGIONS] = [{ monitorId: 1, regionId: 2 }];

    const lines = await ndjsonLines(exportStream({ scope: 'all', sinceDays: 90 } as never));

    expect(lines.slice(1)).toEqual([{ t: MONITOR_REGIONS, r: { monitorId: 1, regionId: 2 } }]);
  });
});

describe('exportStream — tar.gz artifact envelope', () => {
  test('packs meta.json, the dump and one entry per artifact', async () => {
    rowsByTable[REGIONS] = [{ id: 1 }];
    listObjectsWithSize.mockResolvedValue([
      { key: 'qa-projects/a.png', size: 3 },
      { key: 'qa-projects/b.png', size: 3 },
    ]);
    getObjectResponse.mockImplementation(async () => new Response('abc'));

    const entries = await tarEntries(
      exportStream({ scope: 'all', sinceDays: 90, includeArtifacts: true } as never),
    );

    expect(Object.keys(entries)).toEqual([
      'meta.json',
      'dump.ndjson',
      'artifacts/qa-projects/a.png',
      'artifacts/qa-projects/b.png',
      'meta-actual.json',
    ]);
    expect(JSON.parse(entries['meta.json'].toString())).toMatchObject({
      format: 1,
      includesArtifacts: true,
      artifactCount: 2,
      artifactBytes: 6,
      scope: 'all',
    });
    // The dump entry is the same NDJSON the plain export emits.
    const dump = entries['dump.ndjson']
      .toString()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(dump[1]).toEqual({ t: REGIONS, r: { id: 1 } });
    expect(entries['artifacts/qa-projects/a.png'].toString()).toBe('abc');
    expect(JSON.parse(entries['meta-actual.json'].toString())).toEqual({
      artifactCount: 2,
      artifactBytes: 6,
      artifactsFailed: 0,
      artifactsPlanned: 2,
    });
  });

  test('a failing artifact fetch is skipped and reported in meta-actual', async () => {
    listObjectsWithSize.mockResolvedValue([
      { key: 'good.png', size: 3 },
      { key: 'bad.png', size: 3 },
    ]);
    getObjectResponse.mockImplementation(async (key: string) => {
      if (key === 'bad.png') throw new Error('s3 timeout');
      return new Response('abc');
    });

    const entries = await tarEntries(
      exportStream({ scope: 'none', sinceDays: 90, includeArtifacts: true } as never),
    );

    expect(Object.keys(entries)).not.toContain('artifacts/bad.png');
    expect(JSON.parse(entries['meta-actual.json'].toString())).toEqual({
      artifactCount: 1,
      artifactBytes: 3,
      artifactsFailed: 1,
      artifactsPlanned: 2,
    });
    // meta.json still shows what was planned — the divergence is the point.
    expect(JSON.parse(entries['meta.json'].toString()).artifactCount).toBe(2);
  });

  test('an artifact with no body counts as failed rather than throwing', async () => {
    listObjectsWithSize.mockResolvedValue([{ key: 'empty.png', size: 0 }]);
    getObjectResponse.mockImplementation(async () => new Response(null));

    const entries = await tarEntries(
      exportStream({ scope: 'none', sinceDays: 90, includeArtifacts: true } as never),
    );

    expect(JSON.parse(entries['meta-actual.json'].toString())).toEqual({
      artifactCount: 0,
      artifactBytes: 0,
      artifactsFailed: 1,
      artifactsPlanned: 1,
    });
  });

  test('still emits a valid envelope when object storage is not configured', async () => {
    objectStorageMock.configured.value = false;

    const entries = await tarEntries(
      exportStream({ scope: 'none', sinceDays: 90, includeArtifacts: true } as never),
    );

    expect(Object.keys(entries)).toEqual(['meta.json', 'dump.ndjson', 'meta-actual.json']);
    expect(JSON.parse(entries['meta.json'].toString()).artifactCount).toBe(0);
    expect(listObjectsWithSize).not.toHaveBeenCalled();
  });
});

describe('estimateArtifacts', () => {
  test('sums the object sizes when storage is configured', async () => {
    listObjectsWithSize.mockResolvedValue([
      { key: 'a', size: 10 },
      { key: 'b', size: 32 },
    ]);

    expect(await estimateArtifacts()).toEqual({ artifactCount: 2, artifactBytes: 42 });
  });

  test('reports zeros without listing when storage is not configured', async () => {
    objectStorageMock.configured.value = false;

    expect(await estimateArtifacts()).toEqual({ artifactCount: 0, artifactBytes: 0 });
    expect(listObjectsWithSize).not.toHaveBeenCalled();
  });
});

/** Run a split export into a fresh temp dir and return its path. */
async function splitInto(opts: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oow-split-'));
  tmpDirs.push(dir);
  await exportSplit(opts as never, dir);
  return dir;
}

describe('exportSplit', () => {
  test('writes a manifest plus one index-prefixed gzip file per table', async () => {
    rowsByTable[REGIONS] = [{ id: 1, slug: 'eu' }];

    const dir = await splitInto({ scope: 'all', sinceDays: 90 });
    const files = (await readdir(dir)).sort();

    expect(files).toContain('manifest.json');
    expect(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))).toMatchObject({
      format: 1,
      scope: 'all',
    });

    // Index prefix keeps FK order recoverable from the filenames alone.
    const regionsFile = files.find((f) => f.endsWith(`_${REGIONS}.ndjson.gz`));
    expect(regionsFile).toMatch(/^\d{2}_/);
    const body = gunzipSync(await readFile(join(dir, regionsFile as string))).toString();
    expect(JSON.parse(body.trim())).toEqual({ t: REGIONS, r: { id: 1, slug: 'eu' } });
  });

  test('config-only scope writes no file for the execution tables', async () => {
    const dir = await splitInto({ scope: 'none', sinceDays: 90 });
    const files = await readdir(dir);

    expect(files.some((f) => f.endsWith(`_${URL_EXECS}.ndjson.gz`))).toBe(false);
    expect(files.some((f) => f.endsWith(`_${REGIONS}.ndjson.gz`))).toBe(true);
  });
});
