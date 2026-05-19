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

const BACKUP_FORMAT = 1;
export const DEFAULT_SINCE_DAYS = 90;

export type DataScope = 'none' | 'window' | 'all';

export interface BackupOptions {
  /** `none` = config only, `window` = config + last `sinceDays`, `all` = everything. */
  scope: DataScope;
  sinceDays: number;
}

interface Manifest {
  format: number;
  ooVersion: string;
  schemaHead: string;
  createdAt: string;
  scope: DataScope;
  sinceDays: number | null;
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
 */
export function exportStream(opts: BackupOptions): ReadableStream<Uint8Array> {
  const gz = createGzip();
  const src = Readable.from(ndjson(opts));
  src.on('error', (e) => gz.destroy(e));
  src.pipe(gz);
  return Readable.toWeb(gz) as unknown as ReadableStream<Uint8Array>;
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

/** Fresh-restore a single-file gzip dump (UI upload / CLI `--from <file>`). */
export async function restore(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  opts: { force: boolean },
): Promise<RestoreResult> {
  const node =
    body instanceof ReadableStream
      ? Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0])
      : (body as Readable);
  return restoreLines(gunzipLines(node), opts);
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
