/**
 * /api/status-pages — slug validation matches regions (lowercase
 * alphanumeric + dashes, 1-64). PUT monitors replaces the full set;
 * sort order matches array order.
 */
import type { Hono } from 'hono';
import { statusPageMonitorRepo, statusPageRepo } from '../db/repositories/status-page.repo.ts';
import type { MonitorType } from '../db/repositories/region.repo.ts';

const MONITOR_TYPES: readonly MonitorType[] = ['url', 'api', 'tcp', 'udp', 'qa', 'db', 'tls'];
const STATUS_PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?$/;

export function registerStatusPageRoutes(app: Hono): void {
  app.get('/api/status-pages', async (c) => {
    const rows = await statusPageRepo.list();
    return c.json(rows);
  });

  app.post('/api/status-pages', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const slug = typeof body.slug === 'string' ? body.slug.trim() : '';
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const description =
      typeof body.description === 'string' ? body.description.trim() || null : null;
    if (!STATUS_PAGE_SLUG_RE.test(slug)) {
      return c.json({ error: 'slug must be lowercase alphanumeric + dashes, max 64 chars' }, 400);
    }
    if (!title) return c.json({ error: 'title is required' }, 400);
    if (await statusPageRepo.findBySlug(slug)) {
      return c.json({ error: `slug '${slug}' is already taken` }, 409);
    }
    const [row] = await statusPageRepo.create({ slug, title, description });
    return c.json(row, 201);
  });

  app.get('/api/status-pages/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const page = await statusPageRepo.findById(id);
    if (!page) return c.json({ error: 'not found' }, 404);
    const monitors = await statusPageMonitorRepo.forPage(id);
    return c.json({ ...page, monitors });
  });

  app.patch('/api/status-pages/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const patch: { title?: string; description?: string | null } = {};
    if (typeof body.title === 'string') patch.title = body.title.trim();
    if (typeof body.description === 'string') patch.description = body.description.trim() || null;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: 'no fields to update' }, 400);
    }
    await statusPageRepo.update(id, patch);
    return c.body(null, 204);
  });

  app.delete('/api/status-pages/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    await statusPageRepo.deleteById(id);
    return c.body(null, 204);
  });

  // Replace the full set of monitors bound to a page. Sort order matches array order.
  app.put('/api/status-pages/:id/monitors', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (!Array.isArray(body.monitors)) {
      return c.json({ error: 'monitors must be an array of {type, id}' }, 400);
    }
    const bindings: Array<{
      monitorType: MonitorType;
      monitorId: number;
    }> = [];
    for (const m of body.monitors as Array<{ type?: unknown; id?: unknown }>) {
      if (!MONITOR_TYPES.includes(m.type as MonitorType) || !Number.isInteger(m.id)) {
        return c.json({ error: `bad monitor entry: ${JSON.stringify(m)}` }, 400);
      }
      bindings.push({
        monitorType: m.type as MonitorType,
        monitorId: m.id as number,
      });
    }
    await statusPageMonitorRepo.set(id, bindings);
    return c.json({ ok: true, monitors: bindings });
  });
}
