/**
 * /api/import — thin shim over `services/import.ts:runImport`.
 *
 * The actual bulk-import logic (per-type adapters, surrogate-id remap,
 * transactional wrap) lives in the service so the handler stays focused
 * on auth + JSON envelope + status-code mapping.
 */
import type { Hono } from 'hono';
import { ImportVersionError, runImport } from '../services/import.ts';
import { logger } from '../utils/logger.ts';

export function registerImportRoutes(app: Hono): void {
  app.post('/api/import', async (c) => {
    const body = (await c.req.json()) as { version?: number; [k: string]: unknown };
    try {
      const result = await runImport(body);
      return c.json(result);
    } catch (err) {
      if (err instanceof ImportVersionError) {
        return c.json({ error: err.message }, 400);
      }
      logger.error(`import failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ error: 'import failed' }, 500);
    }
  });
}
