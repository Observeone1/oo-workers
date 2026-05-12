/**
 * HTTP server: REST API + static UI.
 * Runs in the same process as workers + scheduler.
 */

import { Hono } from 'hono';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { urlMonitorRepo } from './db/repositories/url-monitor.repo.ts';
import { apiCheckRepo } from './db/repositories/api-check.repo.ts';
import { qaProjectRepo } from './db/repositories/qa-project.repo.ts';
import { logger } from './utils/logger.ts';

const PUBLIC_DIR = resolve(import.meta.dir, '../public');

function loadText(name: string): string | null {
  const p = join(PUBLIC_DIR, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
const ASSETS = {
  indexHtml: loadText('index.html'),
  appJs:     loadText('app.js'),
  docsHtml:  loadText('docs.html'),
};

export function buildApp(connection: Redis) {
  const app = new Hono();
  const urlQ = new Queue('url-monitor', { connection });
  const apiQ = new Queue('api-check', { connection });
  const qaQ = new Queue('qa-project', { connection });

  // ---------- API: list ----------
  app.get('/api/monitors', async (c) => {
    const [urls, apis, qas] = await Promise.all([
      urlMonitorRepo.findAllWithLatest(),
      apiCheckRepo.findAllWithLatest(),
      qaProjectRepo.findAllWithLatest(),
    ]);
    return c.json({ url: urls, api: apis, qa: qas });
  });

  // ---------- API: detail ----------
  app.get('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);

    if (type === 'url') {
      const [m] = await urlMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const [assertions, runs] = await Promise.all([
        urlMonitorRepo.findAssertionsByMonitorId(id),
        urlMonitorRepo.findExecutionsByMonitorId(id),
      ]);
      return c.json({ monitor: { ...m, type: 'url' }, assertions, runs });
    }
    if (type === 'api') {
      const [m] = await apiCheckRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const [assertions, runs] = await Promise.all([
        apiCheckRepo.findAssertionsByCheckId(id),
        apiCheckRepo.findExecutionsByCheckId(id),
      ]);
      return c.json({ monitor: { ...m, type: 'api' }, assertions, runs });
    }
    if (type === 'qa') {
      const [m] = await qaProjectRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const [tests, runs] = await Promise.all([
        qaProjectRepo.findTestsByProjectId(id),
        qaProjectRepo.findExecutionsByProjectId(id),
      ]);
      return c.json({ monitor: { ...m, type: 'qa' }, tests, runs });
    }
    return c.json({ error: 'bad type' }, 400);
  });

  // ---------- API: create ----------
  app.post('/api/monitors/url', async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.url) return c.json({ error: 'name + url required' }, 400);
    const [m] = await urlMonitorRepo.create({
      name: body.name,
      url: body.url,
      timeoutMs: body.timeoutMs ?? 30000,
      intervalSeconds: body.intervalSeconds ?? 60,
      enabled: body.enabled ?? true,
    });
    for (const a of (body.assertions ?? []) as Array<{ operator: string; statusCode: number }>) {
      await urlMonitorRepo.createAssertion(m.id, { operator: a.operator, statusCode: a.statusCode });
    }
    return c.json(m, 201);
  });

  app.post('/api/monitors/api', async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.url) return c.json({ error: 'name + url required' }, 400);
    const [m] = await apiCheckRepo.create({
      name: body.name,
      url: body.url,
      method: body.method ?? 'GET',
      headers: body.headers ?? {},
      body: body.body ?? null,
      timeoutMs: body.timeoutMs ?? 10000,
      intervalSeconds: body.intervalSeconds ?? 60,
      enabled: body.enabled ?? true,
    });
    for (const a of (body.assertions ?? []) as Array<{ type: string; operator: string; path?: string; value?: string }>) {
      await apiCheckRepo.createAssertion(m.id, { type: a.type, operator: a.operator, path: a.path ?? null, value: a.value ?? null });
    }
    return c.json(m, 201);
  });

  app.post('/api/monitors/qa', async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.targetUrl || !Array.isArray(body.tests) || body.tests.length === 0) {
      return c.json({ error: 'name + targetUrl + tests[] required' }, 400);
    }
    const [m] = await qaProjectRepo.create({
      name: body.name,
      targetUrl: body.targetUrl,
      credentials: body.credentials ?? null,
      config: body.config ?? {},
      intervalSeconds: body.intervalSeconds ?? 300,
      enabled: body.enabled ?? true,
      status: 'active',
    });
    for (const t of body.tests as Array<{ name: string; script: string; description?: string }>) {
      await qaProjectRepo.createTest(m.id, { testName: t.name, testType: 'browser', script: t.script, description: t.description ?? null });
    }
    return c.json(m, 201);
  });

  // ---------- API: delete ----------
  app.delete('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (type === 'url')      await urlMonitorRepo.deleteById(id);
    else if (type === 'api') await apiCheckRepo.deleteById(id);
    else if (type === 'qa')  await qaProjectRepo.deleteById(id);
    else return c.json({ error: 'bad type' }, 400);
    return c.body(null, 204);
  });

  // ---------- API: enable/disable ----------
  app.patch('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (bool) required' }, 400);
    if (type === 'url')      await urlMonitorRepo.updateEnabled(id, body.enabled);
    else if (type === 'api') await apiCheckRepo.updateEnabled(id, body.enabled);
    else if (type === 'qa')  await qaProjectRepo.updateEnabled(id, body.enabled);
    else return c.json({ error: 'bad type' }, 400);
    return c.body(null, 204);
  });

  // ---------- API: run now ----------
  app.post('/api/monitors/:type/:id/run', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (type === 'url') {
      const [m] = await urlMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const assertions = await urlMonitorRepo.findAssertionsByMonitorId(id);
      const [exec] = await urlMonitorRepo.createExecution(id, 'PENDING');
      await urlQ.add('check', { executionId: exec.id, monitor: { id: m.id, url: m.url, timeoutMs: m.timeoutMs }, assertions });
      return c.json({ executionId: exec.id });
    }
    if (type === 'api') {
      const [m] = await apiCheckRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const assertions = await apiCheckRepo.findAssertionsByCheckId(id);
      const [exec] = await apiCheckRepo.createExecution(id, 'PENDING');
      await apiQ.add('check', { executionId: exec.id, apiCheck: m, assertions });
      return c.json({ executionId: exec.id });
    }
    if (type === 'qa') {
      const [m] = await qaProjectRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const tests = await qaProjectRepo.findTestsWithScriptByProjectId(id);
      if (tests.length === 0) return c.json({ error: 'no tests on this project' }, 400);
      await qaQ.add('run', {
        type: 'qa-project-run',
        projectId: m.id,
        targetUrl: m.targetUrl,
        credentials: m.credentials ?? undefined,
        config: m.config ?? {},
        tests,
        triggeredAt: new Date().toISOString(),
      });
      return c.json({ ok: true });
    }
    return c.json({ error: 'bad type' }, 400);
  });

  // ---------- API: bulk import ----------
  app.post('/api/import', async (c) => {
    const body = await c.req.json();
    if (body.version !== 1) return c.json({ error: 'unsupported import version' }, 400);
    const created = { url: 0, api: 0, qa: 0, skipped: [] as string[] };

    for (const u of (body.urlMonitors ?? []) as any[]) {
      try {
        const [m] = await urlMonitorRepo.create({
          name: u.name,
          url: u.url,
          timeoutMs: u.timeoutMs ?? 30000,
          intervalSeconds: u.intervalSeconds ?? 60,
          enabled: u.enabled ?? true,
        });
        for (const a of u.assertions ?? []) {
          await urlMonitorRepo.createAssertion(m.id, { operator: a.operator, statusCode: a.statusCode });
        }
        created.url++;
      } catch (err) {
        created.skipped.push(`url ${u.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const a of (body.apiChecks ?? []) as any[]) {
      try {
        const [m] = await apiCheckRepo.create({
          name: a.name,
          url: a.url,
          method: a.method ?? 'GET',
          headers: a.headers ?? {},
          body: a.body ?? null,
          timeoutMs: a.timeoutMs ?? 10000,
          intervalSeconds: a.intervalSeconds ?? 60,
          enabled: a.enabled ?? true,
        });
        for (const ass of a.assertions ?? []) {
          await apiCheckRepo.createAssertion(m.id, { type: ass.type, operator: ass.operator, path: ass.path ?? null, value: ass.value ?? null });
        }
        created.api++;
      } catch (err) {
        created.skipped.push(`api ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const q of (body.qaProjects ?? []) as any[]) {
      try {
        const [m] = await qaProjectRepo.create({
          name: q.name,
          targetUrl: q.targetUrl,
          credentials: q.credentials ?? null,
          config: q.config ?? {},
          intervalSeconds: q.intervalSeconds ?? 300,
          enabled: q.enabled ?? true,
          status: 'active',
        });
        for (const t of q.tests ?? []) {
          await qaProjectRepo.createTest(m.id, { testName: t.name, testType: 'browser', script: t.script, description: t.description ?? null });
        }
        created.qa++;
      } catch (err) {
        created.skipped.push(`qa ${q.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return c.json(created);
  });

  // ---------- static UI ----------
  app.get('/', (c) => ASSETS.indexHtml
    ? c.html(ASSETS.indexHtml)
    : c.text('UI not built — run `bun run build:ui`', 500));
  app.get('/app.js', (c) => ASSETS.appJs
    ? c.body(ASSETS.appJs, 200, { 'content-type': 'application/javascript' })
    : c.text('// not built', 404));
  app.get('/docs', (c) => ASSETS.docsHtml
    ? c.html(ASSETS.docsHtml)
    : c.text('docs not built', 500));

  return { app, close: async () => { await Promise.all([urlQ.close(), apiQ.close(), qaQ.close()]); } };
}

export function startServer(connection: Redis, port: number) {
  const { app, close } = buildApp(connection);
  const server = Bun.serve({ port, fetch: app.fetch });
  logger.info(`🌐 server listening on http://localhost:${port}`);
  return async () => { server.stop(); await close(); };
}
