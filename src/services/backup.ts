/**
 * Full logical backup & restore — instance DR snapshot.
 *
 * Implementation split across three files so each side stays focused:
 *
 *   - `backup-shared.ts` — types, constants, the FK-ordered `TABLES`
 *     spec, schemaHead / ooVersion / hydrate helpers. Both sides
 *     depend on this; nothing in there pulls in either side.
 *
 *   - `backup-export.ts` — `exportStream`, `exportTarGz`, `exportSplit`,
 *     `estimateArtifacts`. The producer side.
 *
 *   - `backup-restore.ts` — `restore`, `restoreFromDir`. The reader
 *     side, with magic-byte format dispatch between legacy NDJSON-gz
 *     and the v1.21.0 tar.gz-with-artifacts envelope.
 *
 * This module re-exports the public surface so existing callers
 * (`src/routes/backup.ts`, the CLI script) keep working unchanged.
 *
 * Distinct from `POST /api/import` (the thin SaaS-migration adapter);
 * does not address its idempotency gap. Object-storage artifacts
 * (Playwright trace.zip / screenshots) ride along when the tar.gz
 * format is requested.
 */

export { exportSplit, exportStream, estimateArtifacts } from './backup-export.ts';

export { restore, restoreFromDir } from './backup-restore.ts';

export {
  BACKUP_FORMAT,
  DEFAULT_SINCE_DAYS,
  RestoreError,
  type BackupOptions,
  type DataScope,
  type Manifest,
  type RestoreResult,
  type TarMeta,
} from './backup-shared.ts';
