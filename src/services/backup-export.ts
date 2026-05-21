/**
 * Full logical backup — the export side.
 *
 * A backup is a single gzip stream of NDJSON: line 0 is a manifest,
 * every subsequent line is `{ t: "<sql_table>", r: { <row> } }`
 * emitted in foreign-key order so the restore can insert as it reads.
 *
 * Config tables always ride along; the high-volume `*_executions`
 * tables are windowed (default last 90 days) and skipped entirely in
 * config-only mode.
 *
 * When `opts.includeArtifacts` is true the writer switches to a
 * tar.gz envelope containing `meta.json` + `dump.ndjson` +
 * `artifacts/<key>` for every object in the configured S3 bucket.
 * Restore (see backup-restore.ts) auto-detects either format via
 * magic-byte sniff, so DB-only consumers stay unaffected.
 */
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { and, asc, getTableColumns, getTableName, gt, gte, type Column } from 'drizzle-orm';
import { db } from '../config/db.ts';
import { logger } from '../utils/logger.ts';
import { getObjectResponse, isStorageConfigured, listObjectsWithSize } from './object-storage.ts';
import {
  BACKUP_FORMAT,
  buildManifest,
  ooVersion,
  schemaHead,
  TABLES,
  READ_BATCH,
  type BackupOptions,
  type TableSpec,
  type TarMeta,
} from './backup-shared.ts';

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
 * envelope (see exportTarGz below).
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
  const { pipeline: pipe } = await import('node:stream/promises');
  const { join } = await import('node:path');

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(await buildManifest(opts), null, 2));

  const jobs = TABLES.map((spec, i) => async () => {
    if (spec.timeCol && opts.scope === 'none') return;
    const file = join(dir, `${String(i).padStart(2, '0')}_${getTableName(spec.table)}.ndjson.gz`);
    await pipe(Readable.from(tableNdjson(spec, opts)), createGzip(), createWriteStream(file));
  });

  const POOL = 4;
  for (let i = 0; i < jobs.length; i += POOL) {
    await Promise.all(jobs.slice(i, i + POOL).map((j) => j()));
  }
}
