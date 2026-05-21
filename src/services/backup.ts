/**
 * Full logical backup & restore — instance DR snapshot.
 *
 * A backup is a single gzip stream of NDJSON: line 0 is a manifest, every
 * subsequent line is `{ t: "<sql_table>", r: { <row> } }` emitted in
 * foreign-key order so the restore can insert as it reads. Config tables
 * always ride along; the six high-volume `*_executions` tables are windowed
 * (default last 90 days) and skipped entirely in config-only mode.
 *
 * Restore is fresh-restore only: the target must be empty, or `force` is
 * set and we TRUNCATE every app table first. IDs are preserved and the
 * serial sequences are bumped past MAX(id) so new rows don't collide. The
 * whole load runs in one transaction.
 *
 * Distinct from `POST /api/import` (the thin SaaS-migration adapter); does
 * not address its idempotency gap. Object-storage artifacts (Playwright
 * trace.zip / screenshots) are not part of the dump — only the DB. QA
 * script bodies live in a DB column and ride along automatically.
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGunzip, createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import {
  and,
  asc,
  getTableColumns,
  getTableName,
  gt,
  gte,
  sql as dsql,
  type Column,
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { db, sql } from '../config/db.ts';
import * as schema from '../db/schema.ts';
import { logger } from '../utils/logger.ts';
import {
  getObjectResponse,
  isStorageConfigured,
  listObjectsWithSize,
  putObject,
} from './object-storage.ts';
import { runBackfill } from './storage-backfill.ts';

const BACKUP_FORMAT = 1;
export const DEFAULT_SINCE_DAYS = 90;

export type DataScope = 'none' | 'window' | 'all';

export interface BackupOptions {
  /** `none` = config only, `window` = config + last `sinceDays`, `all` = everything. */
  scope: DataScope;
  sinceDays: number;
  /**
   * When true, the output is a tar.gz envelope containing `meta.json`,
   * `dump.ndjson`, and `artifacts/<key>` entries mirroring the S3 bucket.
   * When false (default), the output is the legacy single-stream `.ndjson.gz`.
   * Restore auto-detects either format via magic-byte sniff.
   */
  includeArtifacts?: boolean;
}

interface Manifest {
  format: number;
  ooVersion: string;
  schemaHead: string;
  createdAt: string;
  scope: DataScope;
  sinceDays: number | null;
}

/** Metadata stored in `meta.json` at the tar root. */
interface TarMeta {
  format: number;
  ooVersion: string;
  schemaHead: string;
  createdAt: string;
  scope: DataScope;
  sinceDays: number | null;
  includesArtifacts: true;
  artifactCount: number;
  artifactBytes: number;
}

/**
 * One table in the dump. `timeCol` is set only for the windowed execution
 * tables. Composite-PK join tables have no serial `id`, so they are read in
 * a single pass and skip the setval reset.
 */
interface TableSpec {
  table: PgTable;
  serial: boolean;
  timeCol?: 'startTime' | 'startedAt';
}

// FK-safe order: parents before children, executions last. This is the
// import correctness spec — do not reorder without re-checking schema.ts.
const TABLES: TableSpec[] = [
  { table: schema.apiKeys, serial: true },
  { table: schema.users, serial: true },
  { table: schema.regions, serial: true },
  { table: schema.urlMonitors, serial: true },
  { table: schema.apiChecks, serial: true },
  { table: schema.tcpMonitors, serial: true },
  { table: schema.udpMonitors, serial: true },
  { table: schema.dbMonitors, serial: true },
  { table: schema.tlsMonitors, serial: true },
  { table: schema.qaProjects, serial: true },
  { table: schema.urlMonitorAssertions, serial: true },
  { table: schema.apiAssertions, serial: true },
  { table: schema.qaGeneratedTests, serial: true },
  { table: schema.alertChannels, serial: true },
  { table: schema.monitorAlertChannels, serial: false },
  { table: schema.monitorRegions, serial: false },
  { table: schema.statusPages, serial: true },
  { table: schema.statusPageMonitors, serial: false },
  { table: schema.incidents, serial: true },
  { table: schema.incidentUpdates, serial: true },
  { table: schema.urlMonitorExecutions, serial: true, timeCol: 'startTime' },
  { table: schema.apiExecutions, serial: true, timeCol: 'startTime' },
  { table: schema.tcpExecutions, serial: true, timeCol: 'startTime' },
  { table: schema.udpExecutions, serial: true, timeCol: 'startTime' },
  { table: schema.dbExecutions, serial: true, timeCol: 'startTime' },
  { table: schema.tlsExecutions, serial: true, timeCol: 'startTime' },
  { table: schema.qaTestExecutions, serial: true, timeCol: 'startedAt' },
];

const SPEC_BY_NAME = new Map(TABLES.map((s) => [getTableName(s.table), s]));
const ALL_TABLE_NAMES = TABLES.map((s) => getTableName(s.table));

const READ_BATCH = 2000;
const WRITE_BATCH = 500;

/** `0014_db.sql` etc. The greatest name == lexicographic migration head. */
async function schemaHead(): Promise<string> {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1
  `;
  return rows[0]?.name ?? '';
}

async function ooVersion(): Promise<string> {
  try {
    const raw = await readFile(resolve(import.meta.dir, '../../package.json'), 'utf8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

async function buildManifest(opts: BackupOptions): Promise<Manifest> {
  return {
    format: BACKUP_FORMAT,
    ooVersion: await ooVersion(),
    schemaHead: await schemaHead(),
    createdAt: new Date().toISOString(),
    scope: opts.scope,
    sinceDays: opts.scope === 'window' ? opts.sinceDays : null,
  };
}

/** NDJSON lines for one table, keyset-paged — flat memory at any size. */
async function* tableNdjson(spec: TableSpec, opts: BackupOptions): AsyncGenerator<string> {
  const name = getTableName(spec.table);
  const cols = getTableColumns(spec.table);

  if (!spec.serial) {
    // Tiny composite-PK join table — single pass, no paging.
    const rows = await db.select().from(spec.table);
    for (const r of rows) yield JSON.stringify({ t: name, r }) + '\n';
    return;
  }

  const cutoff =
    opts.scope === 'window' ? new Date(Date.now() - opts.sinceDays * 86_400_000) : null;
  const idCol = cols.id as Column;
  const timeCol = spec.timeCol ? (cols[spec.timeCol] as Column) : undefined;
  let lastId = 0;
  for (;;) {
    const where =
      cutoff && timeCol ? and(gt(idCol, lastId), gte(timeCol, cutoff)) : gt(idCol, lastId);
    const rows = (await db
      .select()
      .from(spec.table)
      .where(where)
      .orderBy(asc(idCol))
      .limit(READ_BATCH)) as Record<string, unknown>[];
    if (rows.length === 0) break;
    for (const r of rows) yield JSON.stringify({ t: name, r }) + '\n';
    lastId = rows[rows.length - 1].id as number;
    if (rows.length < READ_BATCH) break;
  }
}

/** Whole dump as NDJSON: manifest line, then every table in FK order. */
async function* ndjson(opts: BackupOptions): AsyncGenerator<string> {
  yield JSON.stringify({ manifest: await buildManifest(opts) }) + '\n';
  for (const spec of TABLES) {
    if (spec.timeCol && opts.scope === 'none') continue;
    yield* tableNdjson(spec, opts);
  }
}

/**
 * A gzip ReadableStream of the dump (one gzip member — `gunzip` decodes it
 * with no multi-member concerns). NDJSON is pushed through `createGzip()`
 * with backpressure: flat memory at both ends. gzip runs on libuv's
 * threadpool, so compression overlaps DB reads without blocking the loop.
 *
 * When `opts.includeArtifacts` is true the writer switches to a tar.gz
 * envelope containing `meta.json` + `dump.ndjson` + `artifacts/<key>` for
 * every object in the configured S3 bucket. Restore auto-detects either
 * format via magic-byte sniff, so DB-only consumers stay unaffected.
 */
export function exportStream(opts: BackupOptions): ReadableStream<Uint8Array> {
  if (opts.includeArtifacts) {
    return exportTarGz(opts);
  }
  const gz = createGzip();
  const src = Readable.from(ndjson(opts));
  src.on('error', (e) => gz.destroy(e));
  src.pipe(gz);
  return Readable.toWeb(gz) as unknown as ReadableStream<Uint8Array>;
}

/**
 * tar.gz envelope writer. Pack order matters: the meta.json header lets
 * a peeking consumer (or a future selective-restore mode) read what's
 * inside before touching the body. NDJSON dump rides as a single tar
 * entry; artifacts follow, streamed one-by-one from S3 so the worker
 * holds at most one object in memory at a time.
 *
 * If object storage isn't configured we still emit a valid envelope —
 * meta.json + dump.ndjson — with `artifactCount: 0`. This keeps the
 * UI flow uniform even on stacks that haven't wired S3.
 */
function exportTarGz(opts: BackupOptions): ReadableStream<Uint8Array> {
  const pack = tar.pack();
  const gz = createGzip();
  pack.pipe(gz);

  (async () => {
    try {
      const keysAndSizes = isStorageConfigured() ? await listObjectsWithSize('') : [];
      const meta: TarMeta = {
        format: BACKUP_FORMAT,
        ooVersion: await ooVersion(),
        schemaHead: await schemaHead(),
        createdAt: new Date().toISOString(),
        scope: opts.scope,
        sinceDays: opts.scope === 'window' ? opts.sinceDays : null,
        includesArtifacts: true,
        artifactCount: keysAndSizes.length,
        artifactBytes: keysAndSizes.reduce((a, k) => a + k.size, 0),
      };

      // meta.json — header first so consumers can read it cheaply.
      await packEntry(pack, 'meta.json', Buffer.from(JSON.stringify(meta, null, 2)));

      // dump.ndjson — write through a PassThrough to get the final length
      // (tar needs Content-Length up-front). Buffered in memory; for very
      // large dumps switch to a streaming-size tar variant later.
      const ndjsonBuf = await streamToBuffer(Readable.from(ndjson(opts)));
      await packEntry(pack, 'dump.ndjson', ndjsonBuf);

      // artifacts/<key> — one tar entry per S3 object, streamed.
      for (const { key, size } of keysAndSizes) {
        try {
          const res = await getObjectResponse(key);
          if (!res.body) continue;
          const entry = pack.entry({ name: `artifacts/${key}`, size });
          const body = Readable.fromWeb(
            res.body as unknown as Parameters<typeof Readable.fromWeb>[0],
          );
          await pipeline(body, entry);
        } catch (err) {
          logger.warn(
            `backup: skipping artifact ${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      pack.finalize();
    } catch (err) {
      pack.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return Readable.toWeb(gz) as unknown as ReadableStream<Uint8Array>;
}

async function packEntry(pack: tar.Pack, name: string, body: Buffer): Promise<void> {
  await new Promise<void>((done, fail) => {
    pack.entry({ name, size: body.length }, body, (err) => (err ? fail(err) : done()));
  });
}

async function streamToBuffer(src: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of src) {
    chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  }
  return Buffer.concat(chunks);
}

/** Used by the GET /api/backup/estimate handler. */
export async function estimateArtifacts(): Promise<{
  artifactCount: number;
  artifactBytes: number;
}> {
  if (!isStorageConfigured()) return { artifactCount: 0, artifactBytes: 0 };
  const entries = await listObjectsWithSize('');
  return {
    artifactCount: entries.length,
    artifactBytes: entries.reduce((a, e) => a + e.size, 0),
  };
}

/**
 * Split form (CLI `--split`): `manifest.json` + one `NN_<table>.ndjson.gz`
 * per table. Independent files → written with bounded concurrency for
 * wall-clock speed on large instances. `restoreFromDir` reconstructs the
 * exact single-file ordering, so single and split are interchangeable.
 */
export async function exportSplit(opts: BackupOptions, dir: string): Promise<void> {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const { join } = await import('node:path');

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(await buildManifest(opts), null, 2));

  const jobs = TABLES.map((spec, i) => async () => {
    if (spec.timeCol && opts.scope === 'none') return;
    const file = join(dir, `${String(i).padStart(2, '0')}_${getTableName(spec.table)}.ndjson.gz`);
    await pipeline(Readable.from(tableNdjson(spec, opts)), createGzip(), createWriteStream(file));
  });

  const POOL = 4;
  for (let i = 0; i < jobs.length; i += POOL) {
    await Promise.all(jobs.slice(i, i + POOL).map((j) => j()));
  }
}

// ---------- restore ----------

export class RestoreError extends Error {}

/** Coerce JSON scalars back to what Drizzle's column types expect. */
function hydrate(table: PgTable, row: Record<string, unknown>): Record<string, unknown> {
  const cols = getTableColumns(table);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = cols[k]?.dataType === 'date' && typeof v === 'string' ? new Date(v) : v;
  }
  return out;
}

async function targetIsEmpty(): Promise<boolean> {
  const probes = [
    schema.users,
    schema.urlMonitors,
    schema.apiChecks,
    schema.tcpMonitors,
    schema.udpMonitors,
    schema.dbMonitors,
    schema.tlsMonitors,
    schema.qaProjects,
    schema.apiKeys,
  ];
  for (const t of probes) {
    const [{ n }] = await db.select({ n: dsql<number>`count(*)::int` }).from(t);
    if (n > 0) return false;
  }
  return true;
}

export interface RestoreResult {
  schemaHead: string;
  counts: Record<string, number>;
}

/**
 * Pipe a gzip stream and yield decoded NDJSON lines. We split manually
 * rather than use `readline` — Bun's readline-over-gunzip async iterator
 * can hang and never close.
 */
async function* gunzipLines(input: Readable): AsyncGenerator<string> {
  const gz = createGunzip();
  input.on('error', (e) => gz.destroy(e));
  input.pipe(gz);
  let buf = '';
  for await (const chunk of gz) {
    buf += (chunk as Buffer).toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) yield line;
      nl = buf.indexOf('\n');
    }
  }
  if (buf.trim()) yield buf;
}

/**
 * Core restore: consume NDJSON lines (manifest first, then rows in FK
 * order), check the schema head, fresh-restore inside one transaction,
 * then bump the serial sequences. Shared by single-file and split.
 */
async function restoreLines(
  lineSource: AsyncIterable<string>,
  opts: { force: boolean },
): Promise<RestoreResult> {
  let manifest: Manifest | undefined;
  const counts: Record<string, number> = {};
  let checked = false;

  await db.transaction(async (tx) => {
    let pendingName = '';
    let pending: Record<string, unknown>[] = [];

    const flush = async () => {
      if (pending.length === 0) return;
      const spec = SPEC_BY_NAME.get(pendingName);
      if (!spec) throw new RestoreError(`unknown table in dump: ${pendingName}`);
      await tx.insert(spec.table).values(pending.map((r) => hydrate(spec.table, r)));
      counts[pendingName] = (counts[pendingName] ?? 0) + pending.length;
      pending = [];
    };

    for await (const line of lineSource) {
      const obj = JSON.parse(line);

      if (obj.manifest) {
        manifest = obj.manifest as Manifest;
        if (manifest.format !== BACKUP_FORMAT) {
          throw new RestoreError(`unsupported backup format ${manifest.format}`);
        }
        const head = await schemaHead();
        if (manifest.schemaHead !== head) {
          throw new RestoreError(
            `schema mismatch: dump is "${manifest.schemaHead}", this instance is "${head}". ` +
              'Run the target through migrations to the same version first.',
          );
        }
        const empty = await targetIsEmpty();
        if (!empty && !opts.force) {
          throw new RestoreError(
            'target database is not empty. Restore replaces all data — re-run with force to confirm.',
          );
        }
        if (!empty) {
          await tx.execute(
            dsql.raw(`TRUNCATE TABLE ${ALL_TABLE_NAMES.join(', ')} RESTART IDENTITY CASCADE`),
          );
        }
        checked = true;
        continue;
      }

      if (!checked) throw new RestoreError('dump did not start with a manifest');
      const { t, r } = obj as { t: string; r: Record<string, unknown> };
      if (t !== pendingName) {
        await flush();
        pendingName = t;
      }
      pending.push(r);
      if (pending.length >= WRITE_BATCH) await flush();
    }
    await flush();

    if (!manifest) throw new RestoreError('empty dump: no manifest');
  });

  // Sequences are non-transactional — bump after commit. Without this the
  // next insert reuses id 1 and collides with restored rows.
  for (const spec of TABLES) {
    if (!spec.serial) continue;
    const name = getTableName(spec.table);
    await sql`
      SELECT setval(
        pg_get_serial_sequence(${name}, 'id'),
        GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${sql(name)}), 1),
        true
      )
    `;
  }

  logger.info(`restore complete: ${JSON.stringify(counts)}`);
  return { schemaHead: manifest!.schemaHead, counts };
}

/**
 * Fresh-restore a single-file gzip dump (UI upload / CLI `--from <file>`).
 *
 * Auto-detects the envelope format by sniffing magic bytes after gunzip:
 *   - tar magic ("ustar" at offset 257) → tar.gz path (meta.json + dump.ndjson + artifacts/)
 *   - everything else                   → legacy NDJSON path (v1.7.0 dumps)
 *
 * Both paths converge on the same single-transaction DB restore. The tar
 * path additionally walks `artifacts/` entries and `putObject`s each to S3,
 * then triggers the boot-time `runBackfill()` so any pre-v1.0 inline-only
 * QA scripts get re-uploaded on the new host.
 */
export async function restore(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  opts: { force: boolean },
): Promise<RestoreResult> {
  const node =
    body instanceof ReadableStream
      ? Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0])
      : (body as Readable);

  // Decompress once. Capture the first tar-header-sized chunk to dispatch,
  // then rebuild a fresh Readable by prepending the peeked bytes to the
  // remaining gunzip output. Cleaner than unshift+pipe interactions.
  const gz = createGunzip();
  node.on('error', (e) => gz.destroy(e));
  node.pipe(gz);

  const iter = gz[Symbol.asyncIterator]();
  const peekChunks: Buffer[] = [];
  let peekLen = 0;
  while (peekLen < 512) {
    const { value, done } = await iter.next();
    if (done) break;
    const buf = typeof value === 'string' ? Buffer.from(value) : (value as Buffer);
    peekChunks.push(buf);
    peekLen += buf.length;
  }
  const peek = Buffer.concat(peekChunks);

  // Re-wrap: yield the peeked buffer first, then drain the rest of the
  // iterator. Downstream consumers see a single contiguous stream.
  async function* combined(): AsyncGenerator<Buffer> {
    if (peek.length > 0) yield peek;
    for (;;) {
      const { value, done } = await iter.next();
      if (done) return;
      yield typeof value === 'string' ? Buffer.from(value) : (value as Buffer);
    }
  }
  const rejoined = Readable.from(combined());

  if (isTarMagic(peek)) {
    return restoreTar(rejoined, opts);
  }
  return restoreLines(linesFromStream(rejoined), opts);
}

/** tar header has `ustar` (with optional null) starting at byte 257. */
function isTarMagic(peek: Buffer): boolean {
  if (peek.length < 263) return false;
  return peek.slice(257, 262).toString('ascii') === 'ustar';
}

/** Split an already-gunzipped stream into NDJSON lines. */
async function* linesFromStream(s: Readable): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of s) {
    buf += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line) yield line;
      nl = buf.indexOf('\n');
    }
  }
  if (buf.trim()) yield buf;
}

/**
 * Restore from a tar (already-gunzipped) stream. The tar pack order is
 * deterministic — `meta.json`, then `dump.ndjson`, then `artifacts/*` —
 * so we exploit it: buffer meta + dump, kick off the DB transaction the
 * moment we hit the first artifact entry (or after the loop if none),
 * then stream each artifact body straight to `putObject` and discard
 * before reading the next entry.
 *
 * Memory ceiling = max(`dump.ndjson`, single largest artifact) instead
 * of the previous `dump + sum(all artifacts)` which OOMed multi-GB
 * dumps. DB-first ordering is preserved: artifact uploads `await`
 * the DB-restore promise on the first artifact iteration, so a DB
 * restore failure aborts before any S3 write.
 *
 * DB is still the durability anchor: artifact upload failures are
 * logged and continued so partial-S3-outage doesn't roll back the DB.
 * Missing-object 404s on browser-run trace links degrade gracefully —
 * same behavior as today.
 */
async function restoreTar(gunzipped: Readable, opts: { force: boolean }): Promise<RestoreResult> {
  const extract = tar.extract();
  let meta: TarMeta | undefined;
  let dumpBuf: Buffer | undefined;
  let dbRestore: Promise<RestoreResult> | null = null;
  let uploaded = 0;
  let failed = 0;
  let seenArtifact = false;

  const startDbRestore = (): Promise<RestoreResult> => {
    if (dbRestore) return dbRestore;
    if (!meta) throw new RestoreError('tar dump missing meta.json');
    if (meta.format !== BACKUP_FORMAT) {
      throw new RestoreError(`unsupported backup format ${meta.format}`);
    }
    if (!dumpBuf) throw new RestoreError('tar dump missing dump.ndjson');
    // Synthesize an NDJSON line iterator over the buffered dump.
    async function* lines(): AsyncGenerator<string> {
      let buf = dumpBuf!.toString('utf8');
      let nl = buf.indexOf('\n');
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) yield line;
        nl = buf.indexOf('\n');
      }
      if (buf.trim()) yield buf;
    }
    dbRestore = restoreLines(lines(), opts);
    return dbRestore;
  };

  gunzipped.pipe(extract);

  for await (const entry of extract as AsyncIterable<
    {
      header: { name: string };
      [Symbol.asyncIterator](): AsyncIterator<Buffer>;
    } & NodeJS.ReadableStream
  >) {
    const name = entry.header.name;

    if (name === 'meta.json' || name === 'dump.ndjson') {
      // Small, buffer fully.
      const chunks: Buffer[] = [];
      for await (const c of entry) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks);
      if (name === 'meta.json') {
        meta = JSON.parse(body.toString('utf8')) as TarMeta;
      } else {
        dumpBuf = body;
      }
      continue;
    }

    if (!name.startsWith('artifacts/')) {
      // Drain unknown entries so the tar stream keeps flowing.
      for await (const _ of entry) {
        void _;
      }
      continue;
    }

    // First artifact entry — DB restore must finish before any S3 write.
    // Subsequent iterations no-op on the await (already-resolved promise).
    seenArtifact = true;
    if (!isStorageConfigured()) {
      // Drain the entry to keep the tar stream flowing; nothing to upload.
      for await (const _ of entry) {
        void _;
      }
      continue;
    }
    await startDbRestore();

    const key = name.slice('artifacts/'.length);
    const contentType = guessContentType(key);
    const chunks: Buffer[] = [];
    for await (const c of entry) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    try {
      await putObject(key, body, contentType);
      uploaded += 1;
    } catch (err) {
      failed += 1;
      logger.warn(
        `restore: artifact upload failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // No artifacts — DB restore never started above, so do it now.
  const result = await startDbRestore();

  if (seenArtifact && isStorageConfigured()) {
    logger.info(`restore: artifacts uploaded=${uploaded} failed=${failed}`);

    // Re-upload any pre-v1.0 inline-only script rows on the new host.
    try {
      const bf = await runBackfill();
      logger.info(`restore: backfill ${JSON.stringify(bf)}`);
    } catch (err) {
      logger.warn(
        `restore: post-restore backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (seenArtifact && !isStorageConfigured()) {
    logger.warn(
      `restore: artifacts present in dump but OO_OBJECT_STORAGE_* not configured — skipped`,
    );
  }

  return result;
}

function guessContentType(key: string): string {
  if (key.endsWith('.zip')) return 'application/zip';
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.jpg') || key.endsWith('.jpeg')) return 'image/jpeg';
  if (key.endsWith('.spec.ts') || key.endsWith('.ts')) return 'text/typescript';
  if (key.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

/**
 * Fresh-restore from a `--split` directory: replay the exact single-file
 * ordering (manifest, then each table file in name order). Split and
 * single-file dumps are interchangeable.
 */
export async function restoreFromDir(
  dir: string,
  opts: { force: boolean },
): Promise<RestoreResult> {
  const { readFile, readdir } = await import('node:fs/promises');
  const { createReadStream } = await import('node:fs');
  const { join } = await import('node:path');

  const manifestRaw = await readFile(join(dir, 'manifest.json'), 'utf8');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson.gz')).sort();

  async function* lines(): AsyncGenerator<string> {
    yield JSON.stringify({ manifest: JSON.parse(manifestRaw) });
    for (const f of files) {
      yield* gunzipLines(createReadStream(join(dir, f)));
    }
  }

  return restoreLines(lines(), opts);
}
