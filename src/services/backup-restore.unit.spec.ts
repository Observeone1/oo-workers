/**
 * Backup restore contract — the single-file NDJSON path, the tar.gz
 * artifact path (including the tar-slip guard) and restoreFromDir.
 *
 * Dumps are built with real gzip/tar and fed in as bytes, so the
 * envelope sniffing, line splitting and tar walking all run for real.
 * Faked: the drizzle `db`/`sql` boundary, object storage, the
 * post-restore backfill, and schemaHead (so a dump can be declared
 * matching or mismatching without a live migrations table).
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  dbMock,
  mockDb,
  mockObjectStorage,
  objectStorageMock,
  resetObjectStorageMock,
} from '../test-support/shared-mocks.ts';
import { gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tar from 'tar-stream';

type Row = Record<string, unknown>;

const HEAD = '0042_add_regions.sql';

/** Rows written through tx.insert(table).values(rows). */
const inserts: { table: string; rows: Row[] }[] = [];
/** Raw statements passed to tx.execute (TRUNCATE). */
const executed: string[] = [];
/** Tagged-template calls on `sql` after commit (setval bumps). */
let sqlCalls = 0;
/** count(*) answers for targetIsEmpty, one per probe table. */
let probeCount = 0;

function selectChain() {
  const c = {
    from: () => c,
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve([{ n: probeCount }]).then(resolve, reject),
  };
  return c;
}

function makeTx() {
  return {
    insert: (table: unknown) => ({
      values: async (rows: Row[]) => {
        inserts.push({ table: tableNameOf(table), rows });
      },
    }),
    execute: async (stmt: unknown) => {
      // dsql.raw() hands back an SQL object; its text lives in queryChunks.
      const chunks = (stmt as { queryChunks?: { value?: unknown }[] })?.queryChunks;
      const text = chunks
        ? chunks.map((c) => (Array.isArray(c?.value) ? c.value.join('') : '')).join('')
        : String(stmt);
      executed.push(text);
    },
  };
}

// drizzle's getTableName needs the real symbol; import lazily to avoid a
// cycle with the schema module in the mock factory.
import { getTableName } from 'drizzle-orm';
function tableNameOf(t: unknown): string {
  return getTableName(t as Parameters<typeof getTableName>[0]);
}

const sqlMock = (...args: unknown[]) => {
  // Used both as a tagged template (setval) and as sql(name) inside one.
  if (Array.isArray((args[0] as { raw?: unknown })?.raw)) sqlCalls++;
  return Promise.resolve([]);
};

mockDb();

let head = HEAD;
const sharedReal = await import('./backup-shared.ts');
mock.module('./backup-shared.ts', () => ({
  ...sharedReal,
  schemaHead: async () => head,
}));

mockObjectStorage();
const { putObject } = objectStorageMock;

const runBackfill = mock(async () => ({
  uploaded: 0,
  migrated: 0,
  orphansDeleted: 0,
  failed: 0,
}));
mock.module('./storage-backfill.ts', () => ({ runBackfill }));

const { restore, restoreFromDir } = await import('./backup-restore.ts');
const { RestoreError } = sharedReal;

const REGIONS = tableNameOf(sharedReal.TABLES[2].table);

function manifestLine(over: Row = {}): string {
  return JSON.stringify({
    manifest: { format: 1, ooVersion: '1.0.0', schemaHead: HEAD, scope: 'all', ...over },
  });
}

/** A gzip NDJSON dump body, as `restore` receives it. */
function ndjsonDump(lines: string[]): Readable {
  return Readable.from([gzipSync(Buffer.from(lines.join('\n') + '\n'))]);
}

/** A gzip tar dump body with the given entries, in order. */
async function tarDump(entries: [string, string | Buffer][]): Promise<Readable> {
  const pack = tar.pack();
  for (const [name, body] of entries) {
    const buf = typeof body === 'string' ? Buffer.from(body) : body;
    await new Promise<void>((done, fail) =>
      pack.entry({ name, size: buf.length }, buf, (e) => (e ? fail(e) : done())),
    );
  }
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  return Readable.from([gzipSync(Buffer.concat(chunks))]);
}

beforeEach(() => {
  inserts.length = 0;
  executed.length = 0;
  sqlCalls = 0;
  probeCount = 0;
  head = HEAD;
  // Shared registrations: prime our own behaviour every time.
  dbMock.db = {
    select: () => selectChain(),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  };
  dbMock.sql = sqlMock;
  resetObjectStorageMock();
  runBackfill.mockClear();
});

describe('restore — single-file NDJSON dump', () => {
  test('inserts rows grouped by table and reports per-table counts', async () => {
    const res = await restore(
      ndjsonDump([
        manifestLine(),
        JSON.stringify({ t: REGIONS, r: { id: 1, slug: 'eu' } }),
        JSON.stringify({ t: REGIONS, r: { id: 2, slug: 'us' } }),
      ]),
      { force: false },
    );

    expect(res.schemaHead).toBe(HEAD);
    expect(res.counts).toEqual({ [REGIONS]: 2 });
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe(REGIONS);
    expect(inserts[0].rows).toHaveLength(2);
  });

  test('bumps the serial sequences after the transaction commits', async () => {
    await restore(ndjsonDump([manifestLine()]), { force: false });

    // One setval per serial table in TABLES.
    const serialCount = sharedReal.TABLES.filter((t) => t.serial).length;
    expect(sqlCalls).toBe(serialCount);
  });

  test('rejects a dump whose format is not the supported one', async () => {
    const err = await restore(ndjsonDump([manifestLine({ format: 2 })]), { force: false }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toBe('unsupported backup format 2');
    expect(inserts).toHaveLength(0);
  });

  test('rejects a dump taken on a different schema head', async () => {
    head = '0099_later.sql';

    const err = await restore(ndjsonDump([manifestLine()]), { force: false }).catch((e) => e);

    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toContain(`dump is "${HEAD}"`);
    expect(err.message).toContain('this instance is "0099_later.sql"');
  });

  test('refuses a non-empty target unless force is set', async () => {
    probeCount = 3;

    const err = await restore(ndjsonDump([manifestLine()]), { force: false }).catch((e) => e);

    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toContain('target database is not empty');
    expect(executed).toHaveLength(0);
  });

  test('truncates every table when forcing over a non-empty target', async () => {
    probeCount = 3;

    await restore(ndjsonDump([manifestLine()]), { force: true });

    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain('TRUNCATE TABLE');
    expect(executed[0]).toContain('RESTART IDENTITY CASCADE');
    expect(executed[0]).toContain(REGIONS);
  });

  test('does not truncate an already-empty target', async () => {
    await restore(ndjsonDump([manifestLine()]), { force: true });

    expect(executed).toHaveLength(0);
  });

  test('rejects rows that arrive before the manifest', async () => {
    const err = await restore(
      ndjsonDump([JSON.stringify({ t: REGIONS, r: { id: 1 } }), manifestLine()]),
      { force: false },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toBe('dump did not start with a manifest');
  });

  test('rejects a table name that is not in the schema', async () => {
    const err = await restore(
      ndjsonDump([manifestLine(), JSON.stringify({ t: 'not_a_table', r: { id: 1 } })]),
      { force: false },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toBe('unknown table in dump: not_a_table');
  });

  test('rejects a dump with no manifest at all', async () => {
    const err = await restore(Readable.from([gzipSync(Buffer.from(''))]), {
      force: false,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toBe('empty dump: no manifest');
  });

  test('flushes in write batches rather than one giant insert', async () => {
    const rows = Array.from({ length: sharedReal.WRITE_BATCH + 1 }, (_, i) =>
      JSON.stringify({ t: REGIONS, r: { id: i + 1 } }),
    );

    const res = await restore(ndjsonDump([manifestLine(), ...rows]), { force: false });

    expect(inserts).toHaveLength(2);
    expect(inserts[0].rows).toHaveLength(sharedReal.WRITE_BATCH);
    expect(inserts[1].rows).toHaveLength(1);
    expect(res.counts[REGIONS]).toBe(sharedReal.WRITE_BATCH + 1);
  });
});

describe('restore — tar.gz artifact dump', () => {
  const meta = JSON.stringify({ format: 1, includesArtifacts: true });
  const dump = `${manifestLine()}\n${JSON.stringify({ t: REGIONS, r: { id: 1 } })}\n`;

  test('restores the db and uploads each artifact with a guessed content type', async () => {
    const res = await restore(
      await tarDump([
        ['meta.json', meta],
        ['dump.ndjson', dump],
        ['artifacts/qa/trace.zip', 'ZIP'],
        ['artifacts/qa/shot.png', 'PNG'],
        ['artifacts/qa/t.spec.ts', 'TS'],
      ]),
      { force: false },
    );

    expect(res.counts).toEqual({ [REGIONS]: 1 });
    expect(putObject.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['qa/trace.zip', 'application/zip'],
      ['qa/shot.png', 'image/png'],
      ['qa/t.spec.ts', 'text/typescript'],
    ]);
    expect(String(putObject.mock.calls[0][1])).toBe('ZIP');
    // The post-restore backfill re-uploads pre-v1.0 inline-only scripts.
    expect(runBackfill).toHaveBeenCalledTimes(1);
  });

  test('falls back to octet-stream for an unknown extension', async () => {
    await restore(
      await tarDump([
        ['meta.json', meta],
        ['dump.ndjson', dump],
        ['artifacts/blob.bin', 'B'],
      ]),
      { force: false },
    );

    expect(putObject.mock.calls[0][2]).toBe('application/octet-stream');
  });

  test('tar-slip: refuses entries that escape the artifacts/ prefix', async () => {
    await restore(
      await tarDump([
        ['meta.json', meta],
        ['dump.ndjson', dump],
        ['artifacts/../../etc/passwd', 'BAD'],
        ['artifacts//abs.png', 'BAD'],
        ['artifacts/ok.png', 'GOOD'],
      ]),
      { force: false },
    );

    // Only the safe key reaches storage.
    expect(putObject.mock.calls.map((c) => c[0])).toEqual(['ok.png']);
  });

  test('skips artifacts entirely when object storage is not configured', async () => {
    objectStorageMock.configured.value = false;

    const res = await restore(
      await tarDump([
        ['meta.json', meta],
        ['dump.ndjson', dump],
        ['artifacts/a.png', 'A'],
      ]),
      { force: false },
    );

    expect(res.counts).toEqual({ [REGIONS]: 1 });
    expect(putObject).not.toHaveBeenCalled();
    expect(runBackfill).not.toHaveBeenCalled();
  });

  test('an upload failure is logged and does not fail the restore', async () => {
    putObject.mockRejectedValueOnce(new Error('s3 down'));

    const res = await restore(
      await tarDump([
        ['meta.json', meta],
        ['dump.ndjson', dump],
        ['artifacts/a.png', 'A'],
        ['artifacts/b.png', 'B'],
      ]),
      { force: false },
    );

    // DB is the durability anchor — it still committed.
    expect(res.counts).toEqual({ [REGIONS]: 1 });
    expect(putObject).toHaveBeenCalledTimes(2);
  });

  test('ignores tar entries that are neither meta, dump nor artifacts', async () => {
    const res = await restore(
      await tarDump([
        ['meta.json', meta],
        ['dump.ndjson', dump],
        ['meta-actual.json', '{"artifactCount":0}'],
      ]),
      { force: false },
    );

    expect(res.counts).toEqual({ [REGIONS]: 1 });
    expect(putObject).not.toHaveBeenCalled();
  });

  test('rejects a tar envelope with no meta.json', async () => {
    const err = await restore(await tarDump([['dump.ndjson', dump]]), { force: false }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toBe('tar dump missing meta.json');
  });

  test('rejects a tar envelope with no dump.ndjson', async () => {
    const err = await restore(await tarDump([['meta.json', meta]]), { force: false }).catch(
      (e) => e,
    );

    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toBe('tar dump missing dump.ndjson');
  });

  test('rejects a tar envelope declaring an unsupported format', async () => {
    const err = await restore(
      await tarDump([
        ['meta.json', JSON.stringify({ format: 99 })],
        ['dump.ndjson', dump],
      ]),
      { force: false },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(RestoreError);
    expect(err.message).toBe('unsupported backup format 99');
  });
});

describe('restoreFromDir', () => {
  test('replays manifest.json then each table file in name order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oow-restore-'));
    try {
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({ format: 1, schemaHead: HEAD, scope: 'all' }),
      );
      await writeFile(
        join(dir, `02_${REGIONS}.ndjson.gz`),
        gzipSync(Buffer.from(JSON.stringify({ t: REGIONS, r: { id: 1 } }) + '\n')),
      );
      // Not a table dump — must be ignored by the *.ndjson.gz filter.
      await writeFile(join(dir, 'README.txt'), 'ignore me');

      const res = await restoreFromDir(dir, { force: false });

      expect(res.schemaHead).toBe(HEAD);
      expect(res.counts).toEqual({ [REGIONS]: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
