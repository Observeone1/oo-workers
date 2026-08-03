/**
 * Full logical restore — the reader side.
 *
 * Two input formats:
 *   - Legacy `.oodump.gz` (raw NDJSON in gzip) — the v1.7.0 format.
 *   - `.oodump.tar.gz` (tar envelope with meta.json + dump.ndjson +
 *     artifacts/<key>) — the v1.21.0 with-artifacts format.
 *
 * Dispatch is by magic-byte sniff on the first ~512 bytes of the
 * gunzipped stream: "ustar" at offset 257 → tar path; everything else
 * → NDJSON path. Both converge on the same single-transaction DB
 * restore.
 *
 * Restore is fresh-restore only: the target must be empty, or `force`
 * is set and we TRUNCATE every app table first. IDs are preserved and
 * the serial sequences are bumped past MAX(id) so new rows don't
 * collide. The whole load runs in one transaction.
 */
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import tar from 'tar-stream';
import { sql as dsql, getTableName } from 'drizzle-orm';
import { db, sql } from '../config/db.ts';
import * as schema from '../db/schema.ts';
import { logger } from '../utils/logger.ts';
import { isStorageConfigured } from './object-storage.ts';
import { runBackfill } from './storage-backfill.ts';
import { drainTarEntry, readTarEntryBuffer, uploadTarArtifact } from './backup-restore-tar.ts';
import {
  ALL_TABLE_NAMES,
  BACKUP_FORMAT,
  hydrate,
  RestoreError,
  schemaHead,
  SPEC_BY_NAME,
  TABLES,
  WRITE_BATCH,
  type Manifest,
  type RestoreResult,
  type TarMeta,
} from './backup-shared.ts';

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

function drainLineBuffer(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buf;
  let nl = rest.indexOf('\n');
  while (nl >= 0) {
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line) lines.push(line);
    nl = rest.indexOf('\n');
  }
  return { lines, rest };
}

async function* linesFromText(text: string): AsyncGenerator<string> {
  const { lines, rest } = drainLineBuffer(text);
  for (const line of lines) yield line;
  if (rest.trim()) yield rest;
}

type RestoreTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function applyManifestChecks(
  manifest: Manifest,
  opts: { force: boolean },
  tx: RestoreTx,
): Promise<void> {
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
    const drained = drainLineBuffer(buf);
    for (const line of drained.lines) yield line;
    buf = drained.rest;
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
        await applyManifestChecks(manifest, opts, tx);
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
  return peek.subarray(257, 262).toString('ascii') === 'ustar';
}

/** Split an already-gunzipped stream into NDJSON lines. */
async function* linesFromStream(s: Readable): AsyncGenerator<string> {
  let buf = '';
  for await (const chunk of s) {
    buf += typeof chunk === 'string' ? chunk : (chunk as Buffer).toString('utf8');
    const drained = drainLineBuffer(buf);
    for (const line of drained.lines) yield line;
    buf = drained.rest;
  }
  if (buf.trim()) yield buf;
}

/**
 * Restore from a tar (already-gunzipped) stream. Streams each artifact body
 * straight to `putObject` and discards before reading the next entry —
 * memory ceiling = max(dump.ndjson, single largest artifact) instead of
 * the previous dump + sum(all artifacts) which OOMed multi-GB dumps. The
 * tar pack order is deterministic (meta → dump → artifacts), so we kick
 * off the DB restore on the first artifact entry and await its promise
 * before any S3 write — DB-first ordering preserved.
 *
 * DB is still the durability anchor: artifact upload failures are logged
 * and continued so partial-S3-outage doesn't roll back the DB. Missing-
 * object 404s on browser-run trace links degrade gracefully.
 */
async function finalizeTarArtifacts(
  seenArtifact: boolean,
  uploaded: number,
  failed: number,
): Promise<void> {
  if (seenArtifact && isStorageConfigured()) {
    logger.info(`restore: artifacts uploaded=${uploaded} failed=${failed}`);
    try {
      const bf = await runBackfill();
      logger.info(`restore: backfill ${JSON.stringify(bf)}`);
    } catch (err) {
      logger.warn(
        `restore: post-restore backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }
  if (seenArtifact && !isStorageConfigured()) {
    logger.warn(
      `restore: artifacts present in dump but OO_OBJECT_STORAGE_* not configured — skipped`,
    );
  }
}

type TarEntry = {
  header: { name: string };
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
} & NodeJS.ReadableStream;

async function handleTarMetaOrDump(
  name: string,
  entry: TarEntry,
  state: { meta?: TarMeta; dumpBuf?: Buffer },
): Promise<void> {
  const body = await readTarEntryBuffer(entry);
  if (name === 'meta.json') {
    state.meta = JSON.parse(body.toString('utf8')) as TarMeta;
  } else {
    state.dumpBuf = body;
  }
}

async function handleTarArtifactEntry(
  name: string,
  entry: TarEntry,
  counters: { uploaded: number; failed: number; seenArtifact: boolean },
  startDbRestore: () => Promise<RestoreResult>,
): Promise<void> {
  counters.seenArtifact = true;
  if (!isStorageConfigured()) {
    await drainTarEntry(entry);
    return;
  }
  await startDbRestore();
  const outcome = await uploadTarArtifact(name, entry, guessContentType);
  if (outcome === 'uploaded') counters.uploaded += 1;
  else if (outcome === 'failed' || outcome === 'skipped-unsafe') counters.failed += 1;
}

async function restoreTar(gunzipped: Readable, opts: { force: boolean }): Promise<RestoreResult> {
  const extract = tar.extract();
  const tarState: { meta?: TarMeta; dumpBuf?: Buffer } = {};
  let dbRestore: Promise<RestoreResult> | null = null;
  const counters = { uploaded: 0, failed: 0, seenArtifact: false };

  const startDbRestore = (): Promise<RestoreResult> => {
    if (dbRestore) return dbRestore;
    if (!tarState.meta) throw new RestoreError('tar dump missing meta.json');
    if (tarState.meta.format !== BACKUP_FORMAT) {
      throw new RestoreError(`unsupported backup format ${tarState.meta.format}`);
    }
    if (!tarState.dumpBuf) throw new RestoreError('tar dump missing dump.ndjson');
    dbRestore = restoreLines(linesFromText(tarState.dumpBuf.toString('utf8')), opts);
    return dbRestore;
  };

  gunzipped.pipe(extract);

  for await (const entry of extract as AsyncIterable<TarEntry>) {
    const name = entry.header.name;
    if (name === 'meta.json' || name === 'dump.ndjson') {
      await handleTarMetaOrDump(name, entry, tarState);
      continue;
    }
    if (!name.startsWith('artifacts/')) {
      await drainTarEntry(entry);
      continue;
    }
    await handleTarArtifactEntry(name, entry, counters, startDbRestore);
  }

  const result = await startDbRestore();
  await finalizeTarArtifacts(counters.seenArtifact, counters.uploaded, counters.failed);
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
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.ndjson.gz'))
    .sort((a, b) => a.localeCompare(b));

  async function* lines(): AsyncGenerator<string> {
    yield JSON.stringify({ manifest: JSON.parse(manifestRaw) });
    for (const f of files) {
      yield* gunzipLines(createReadStream(join(dir, f)));
    }
  }

  return restoreLines(lines(), opts);
}
