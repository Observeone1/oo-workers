/**
 * /api/backup, /api/backup/estimate, /api/restore — full logical
 * backup + restore. Both formats (.oodump.gz and .oodump.tar.gz with
 * artifacts) live in the same export stream; restore auto-detects via
 * magic-byte sniff. See services/backup.ts.
 */
import type { Hono } from 'hono';
import {
  DEFAULT_SINCE_DAYS,
  estimateArtifacts,
  exportStream,
  restore,
  RestoreError,
  type DataScope,
} from '../services/backup.ts';
import { logger } from '../utils/logger.ts';

export function registerBackupRoutes(app: Hono): void {
  // GET streams a gzip dump. Two formats:
  //   - default: legacy NDJSON-gz (config + windowed execution data)
  //   - ?includeArtifacts=1: tar.gz envelope with meta.json + dump.ndjson +
  //                          artifacts/<key> for every S3 object (QA scripts
  //                          + per-run traces/screenshots). Restore detects
  //                          either format via magic-byte sniff.
  // scope: window (default, last `since` days) | all | none (config only).
  app.get('/api/backup', (c) => {
    const scopeParam = c.req.query('scope');
    const scope: DataScope = scopeParam === 'all' || scopeParam === 'none' ? scopeParam : 'window';
    const since = Number(c.req.query('since')) || DEFAULT_SINCE_DAYS;
    const includeArtifacts = c.req.query('includeArtifacts') === '1';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = includeArtifacts
      ? `oo-backup-${stamp}.oodump.tar.gz`
      : `oo-backup-${stamp}.oodump.gz`;
    return new Response(exportStream({ scope, sinceDays: since, includeArtifacts }), {
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${filename}"`,
        'cache-control': 'no-store',
      },
    });
  });

  // GET /api/backup/estimate — UI Backup dialog preview. Returns 0/0 if
  // object storage isn't configured.
  app.get('/api/backup/estimate', async (c) => {
    try {
      const result = await estimateArtifacts();
      return c.json(result);
    } catch (err) {
      logger.error(`backup estimate failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ artifactCount: 0, artifactBytes: 0 });
    }
  });

  // POST the raw gzip dump as the request body. Fresh-restore: refuses a
  // non-empty target unless ?force=1 (UI collects a typed confirmation).
  app.post('/api/restore', async (c) => {
    const force = c.req.query('force') === '1';
    const body = c.req.raw.body;
    if (!body) return c.json({ error: 'request body required (the .oodump.gz)' }, 400);
    try {
      const result = await restore(body, { force });
      return c.json(result);
    } catch (err) {
      if (err instanceof RestoreError) return c.json({ error: err.message }, 400);
      logger.error(`restore failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: 'restore failed' }, 500);
    }
  });
}
