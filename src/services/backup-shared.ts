/**
 * Shared types + constants + helpers for the full logical backup &
 * restore pipeline. Both backup-export.ts and backup-restore.ts depend
 * on this file; nothing in here references either side, so importing
 * it never pulls in the other half.
 *
 * The dump format spec lives here so a reader can audit the contract
 * (manifest line, FK-ordered rows, tar envelope for the artifact mode)
 * without paging through stream-writer or restore-loader code.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { sql } from '../config/db.ts';
import * as schema from '../db/schema.ts';

export const BACKUP_FORMAT = 1;
export const DEFAULT_SINCE_DAYS = 90;
export const READ_BATCH = 2000;
export const WRITE_BATCH = 500;

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

export interface Manifest {
  format: number;
  ooVersion: string;
  schemaHead: string;
  createdAt: string;
  scope: DataScope;
  sinceDays: number | null;
}

/** Metadata stored in `meta.json` at the tar root. */
export interface TarMeta {
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

export interface RestoreResult {
  schemaHead: string;
  counts: Record<string, number>;
}

export class RestoreError extends Error {}

/**
 * One table in the dump. `timeCol` is set only for the windowed execution
 * tables. Composite-PK join tables have no serial `id`, so they are read in
 * a single pass and skip the setval reset.
 */
export interface TableSpec {
  table: PgTable;
  serial: boolean;
  timeCol?: 'startTime' | 'startedAt';
}

// FK-safe order: parents before children, executions last. This is the
// import correctness spec — do not reorder without re-checking schema.ts.
export const TABLES: TableSpec[] = [
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
  { table: schema.heartbeatMonitors, serial: true },
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
  // qa_runs before qa_test_executions: the latter's run_id FKs to it, so it
  // must restore first. Its own deps (qa_projects, regions) are above.
  { table: schema.qaRuns, serial: true, timeCol: 'startedAt' },
  { table: schema.qaTestExecutions, serial: true, timeCol: 'startedAt' },
];

export const SPEC_BY_NAME = new Map(TABLES.map((s) => [getTableName(s.table), s]));
export const ALL_TABLE_NAMES = TABLES.map((s) => getTableName(s.table));

/** `0014_db.sql` etc. The greatest name == lexicographic migration head. */
export async function schemaHead(): Promise<string> {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1
  `;
  return rows[0]?.name ?? '';
}

export async function ooVersion(): Promise<string> {
  try {
    const raw = await readFile(resolve(import.meta.dir, '../../package.json'), 'utf8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

export async function buildManifest(opts: BackupOptions): Promise<Manifest> {
  return {
    format: BACKUP_FORMAT,
    ooVersion: await ooVersion(),
    schemaHead: await schemaHead(),
    createdAt: new Date().toISOString(),
    scope: opts.scope,
    sinceDays: opts.scope === 'window' ? opts.sinceDays : null,
  };
}

/** Coerce JSON scalars back to what Drizzle's column types expect. */
export function hydrate(table: PgTable, row: Record<string, unknown>): Record<string, unknown> {
  const cols = getTableColumns(table);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = cols[k]?.dataType === 'date' && typeof v === 'string' ? new Date(v) : v;
  }
  return out;
}
