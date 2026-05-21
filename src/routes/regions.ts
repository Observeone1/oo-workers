/**
 * /api/regions — multi-region admin. A region is "online" if its
 * last_seen_at is within ONLINE_THRESHOLD_MS (1 minute). Long-poll
 * traffic refreshes last_seen_at on every poll.
 */
import type { Hono } from 'hono';
import { regionRepo } from '../db/repositories/region.repo.ts';
import {
  createRegionWithKey,
  deleteRegion,
  RegionAdminError,
  rotateRegionKey,
} from '../services/region-admin.ts';
import { packageVersion } from '../utils/version.ts';

const ONLINE_THRESHOLD_MS = 60_000;

export function registerRegionRoutes(app: Hono): void {
  app.get('/api/regions', async (c) => {
    const rows = await regionRepo.list();
    const now = Date.now();
    const masterVersion = packageVersion();
    return c.json(
      rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        label: r.label,
        lastSeenAt: r.lastSeenAt,
        createdAt: r.createdAt,
        online: r.lastSeenAt ? now - r.lastSeenAt.getTime() < ONLINE_THRESHOLD_MS : false,
        agentVersion: r.agentVersion,
        masterVersion,
        // Skew: agent reported a version AND it differs from master.
        // Online check intentionally omitted: an offline-then-back agent
        // still needs the warning so the operator upgrades before the
        // next outage window.
        versionSkew: r.agentVersion !== null && r.agentVersion !== masterVersion,
      })),
    );
  });

  app.post('/api/regions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    if (!slug || !label) return c.json({ error: 'slug and label are required' }, 400);
    try {
      const { region, cleartextKey } = await createRegionWithKey(slug, label);
      return c.json(
        {
          region: {
            id: region.id,
            slug: region.slug,
            label: region.label,
            createdAt: region.createdAt,
          },
          // Shown once; the UI must copy it before navigating away.
          cleartextKey,
        },
        201,
      );
    } catch (err) {
      if (err instanceof RegionAdminError) {
        const status = err.code === 'slug_taken' ? 409 : 400;
        return c.json({ error: err.message, code: err.code }, status);
      }
      throw err;
    }
  });

  app.delete('/api/regions/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    try {
      await deleteRegion(id);
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof RegionAdminError && err.code === 'not_found') {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });

  app.post('/api/regions/:id/rotate-key', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    try {
      const { region, cleartextKey } = await rotateRegionKey(id);
      return c.json({
        region: { id: region.id, slug: region.slug, label: region.label },
        cleartextKey,
      });
    } catch (err) {
      if (err instanceof RegionAdminError && err.code === 'not_found') {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
  });
}
