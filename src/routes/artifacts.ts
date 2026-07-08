/**
 * /api/artifacts — read-gated proxy that streams a stored run artifact
 * back to the browser. RustFS sits on the private compose network and is
 * not directly reachable from the dashboard; this is the bridge.
 *
 * Restricted to keys under qa-projects/.../runs/ so it can't be
 * repurposed as a general bucket reader.
 */
import type { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.ts';
import { getObjectResponse } from '../services/object-storage.ts';
import { logger } from '../utils/logger.ts';

const ARTIFACT_KEY_RE = /^qa-projects\/\d+-[a-z0-9-]+\/runs\/\d+\/[\w.-]+$/;

export function registerArtifactsRoutes(app: Hono): void {
  app.use('/api/artifacts', requireAuth('read'));
  app.get('/api/artifacts', async (c) => {
    const key = c.req.query('key') ?? '';
    if (!key || !ARTIFACT_KEY_RE.test(key)) {
      return c.json({ error: 'bad or unauthorized key' }, 400);
    }
    let res: Response;
    try {
      res = await getObjectResponse(key);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 500;
      // Keep storage internals (endpoint/path/driver detail) out of the client
      // response; log them instead.
      logger.error(
        `artifact fetch failed for key ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return c.json({ error: 'fetch failed' }, status === 404 ? 404 : 502);
    }
    const filename = key.split('/').pop() ?? 'artifact';
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    const disposition = filename.endsWith('.zip')
      ? `attachment; filename="${filename}"`
      : `inline; filename="${filename}"`;
    return new Response(res.body, {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-disposition': disposition,
        'cache-control': 'private, max-age=60',
      },
    });
  });
}
