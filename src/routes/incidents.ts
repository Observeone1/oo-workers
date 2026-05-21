/**
 * /api/incidents — operator-authored status-page timeline. Write-gated
 * even on GET (the public consumes incidents through /status/<slug>
 * only, never /api/incidents). An incident is a thread of updates;
 * severity is denormalised onto the incident from the latest update.
 */
import type { Hono } from 'hono';
import { incidentRepo, SEVERITIES, type Severity } from '../db/repositories/incident.repo.ts';
import { statusPageRepo } from '../db/repositories/status-page.repo.ts';

const isSeverity = (s: unknown): s is Severity =>
  typeof s === 'string' && (SEVERITIES as readonly string[]).includes(s);

export function registerIncidentRoutes(app: Hono): void {
  app.get('/api/incidents', async (c) => {
    const pageId = Number(c.req.query('status_page_id'));
    if (!Number.isFinite(pageId)) return c.json({ error: 'status_page_id required' }, 400);
    const f = c.req.query('filter');
    const filter = f === 'active' || f === 'resolved' ? f : 'all';
    return c.json(await incidentRepo.listForPage(pageId, filter));
  });

  app.post('/api/incidents', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const statusPageId = Number(body.status_page_id ?? body.statusPageId);
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!Number.isFinite(statusPageId)) return c.json({ error: 'status_page_id required' }, 400);
    if (!title) return c.json({ error: 'title is required' }, 400);
    if (!text) return c.json({ error: 'body is required' }, 400);
    if (!isSeverity(body.severity)) {
      return c.json({ error: `severity must be one of ${SEVERITIES.join(', ')}` }, 400);
    }
    if (!(await statusPageRepo.findById(statusPageId))) {
      return c.json({ error: 'status page not found' }, 404);
    }
    const row = await incidentRepo.create({
      statusPageId,
      title,
      severity: body.severity,
      body: text,
    });
    return c.json(row, 201);
  });

  app.get('/api/incidents/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const inc = await incidentRepo.findById(id);
    if (!inc) return c.json({ error: 'not found' }, 404);
    return c.json(inc);
  });

  app.post('/api/incidents/:id/updates', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const text = typeof body.body === 'string' ? body.body.trim() : '';
    if (!text) return c.json({ error: 'body is required' }, 400);
    if (!isSeverity(body.severity)) {
      return c.json({ error: `severity must be one of ${SEVERITIES.join(', ')}` }, 400);
    }
    const upd = await incidentRepo.addUpdate(id, { severity: body.severity, body: text });
    if (!upd) return c.json({ error: 'not found' }, 404);
    return c.json(upd, 201);
  });

  app.patch('/api/incidents/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    if (!title) return c.json({ error: 'title is required' }, 400);
    await incidentRepo.updateTitle(id, title);
    return c.body(null, 204);
  });

  app.delete('/api/incidents/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    await incidentRepo.deleteById(id);
    return c.body(null, 204);
  });
}
