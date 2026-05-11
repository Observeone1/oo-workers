/**
 * HTTP server: REST API + static UI.
 * Runs in the same process as workers + scheduler.
 */

import { Hono } from 'hono';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sql } from './config/db.ts';
import { logger } from './utils/logger.ts';

const PUBLIC_DIR = resolve(import.meta.dir, '../public');

export function buildApp(connection: Redis) {
  const app = new Hono();
  const urlQ = new Queue('url-monitor', { connection });
  const apiQ = new Queue('api-check', { connection });
  const qaQ = new Queue('qa-project', { connection });

  // ---------- API: list ----------
  app.get('/api/monitors', async (c) => {
    const urls = await sql`
      SELECT m.*, 'url' AS type,
        (SELECT row_to_json(e) FROM (
          SELECT id, status, status_code, response_time_ms, error_message, start_time
          FROM url_monitor_executions
          WHERE url_monitor_id = m.id ORDER BY start_time DESC LIMIT 1
        ) e) AS latest
      FROM url_monitors m ORDER BY id DESC
    `;
    const apis = await sql`
      SELECT c.*, 'api' AS type,
        (SELECT row_to_json(e) FROM (
          SELECT id, status, response_status AS status_code, response_time_ms, error_message, start_time
          FROM api_executions
          WHERE api_check_id = c.id ORDER BY start_time DESC LIMIT 1
        ) e) AS latest
      FROM api_checks c ORDER BY id DESC
    `;
    const qas = await sql`
      SELECT p.*, 'qa' AS type,
        (SELECT row_to_json(e) FROM (
          SELECT id, status, duration_ms, error_message, started_at AS start_time
          FROM qa_test_executions
          WHERE project_id = p.id ORDER BY started_at DESC LIMIT 1
        ) e) AS latest,
        (SELECT COUNT(*) FROM qa_generated_tests WHERE project_id = p.id) AS test_count
      FROM qa_projects p ORDER BY id DESC
    `;
    return c.json({ url: urls, api: apis, qa: qas });
  });

  // ---------- API: detail ----------
  app.get('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);

    if (type === 'url') {
      const [m] = await sql`SELECT * FROM url_monitors WHERE id = ${id}`;
      if (!m) return c.json({ error: 'not found' }, 404);
      const assertions = await sql`SELECT * FROM url_monitor_assertions WHERE url_monitor_id = ${id}`;
      const runs = await sql`SELECT * FROM url_monitor_executions WHERE url_monitor_id = ${id} ORDER BY start_time DESC LIMIT 100`;
      return c.json({ monitor: { ...m, type: 'url' }, assertions, runs });
    }
    if (type === 'api') {
      const [m] = await sql`SELECT * FROM api_checks WHERE id = ${id}`;
      if (!m) return c.json({ error: 'not found' }, 404);
      const assertions = await sql`SELECT * FROM api_assertions WHERE api_check_id = ${id}`;
      const runs = await sql`SELECT * FROM api_executions WHERE api_check_id = ${id} ORDER BY start_time DESC LIMIT 100`;
      return c.json({ monitor: { ...m, type: 'api' }, assertions, runs });
    }
    if (type === 'qa') {
      const [m] = await sql`SELECT * FROM qa_projects WHERE id = ${id}`;
      if (!m) return c.json({ error: 'not found' }, 404);
      const tests = await sql`SELECT id, test_name, test_type, description, length(script) AS script_size FROM qa_generated_tests WHERE project_id = ${id}`;
      const runs = await sql`SELECT * FROM qa_test_executions WHERE project_id = ${id} ORDER BY started_at DESC LIMIT 100`;
      return c.json({ monitor: { ...m, type: 'qa' }, tests, runs });
    }
    return c.json({ error: 'bad type' }, 400);
  });

  // ---------- API: create ----------
  app.post('/api/monitors/url', async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.url) return c.json({ error: 'name + url required' }, 400);
    const [m] = await sql`
      INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
      VALUES (${body.name}, ${body.url}, ${body.timeout_ms ?? 30000}, ${body.interval_seconds ?? 60}, ${body.enabled ?? true})
      RETURNING *
    `;
    for (const a of (body.assertions ?? []) as Array<{ operator: string; status_code: number }>) {
      await sql`INSERT INTO url_monitor_assertions (url_monitor_id, operator, status_code) VALUES (${m.id}, ${a.operator}, ${a.status_code})`;
    }
    return c.json(m, 201);
  });

  app.post('/api/monitors/api', async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.url) return c.json({ error: 'name + url required' }, 400);
    const [m] = await sql`
      INSERT INTO api_checks (name, url, method, headers, body, timeout_ms, interval_seconds, enabled)
      VALUES (${body.name}, ${body.url}, ${body.method ?? 'GET'}, ${body.headers ?? {}}, ${body.body ?? null}, ${body.timeout_ms ?? 10000}, ${body.interval_seconds ?? 60}, ${body.enabled ?? true})
      RETURNING *
    `;
    for (const a of (body.assertions ?? []) as Array<{ type: string; operator: string; path?: string; value?: string }>) {
      await sql`INSERT INTO api_assertions (api_check_id, type, operator, path, value) VALUES (${m.id}, ${a.type}, ${a.operator}, ${a.path ?? null}, ${a.value ?? null})`;
    }
    return c.json(m, 201);
  });

  app.post('/api/monitors/qa', async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.target_url || !Array.isArray(body.tests) || body.tests.length === 0) {
      return c.json({ error: 'name + target_url + tests[] required' }, 400);
    }
    const [m] = await sql`
      INSERT INTO qa_projects (name, target_url, credentials, config, interval_seconds, enabled, status)
      VALUES (${body.name}, ${body.target_url}, ${body.credentials ?? null}, ${body.config ?? {}}, ${body.interval_seconds ?? 300}, ${body.enabled ?? true}, 'active')
      RETURNING *
    `;
    for (const t of body.tests as Array<{ name: string; script: string; description?: string }>) {
      await sql`INSERT INTO qa_generated_tests (project_id, test_name, test_type, script, description) VALUES (${m.id}, ${t.name}, 'browser', ${t.script}, ${t.description ?? null})`;
    }
    return c.json(m, 201);
  });

  // ---------- API: delete ----------
  app.delete('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (type === 'url')      await sql`DELETE FROM url_monitors WHERE id = ${id}`;
    else if (type === 'api') await sql`DELETE FROM api_checks WHERE id = ${id}`;
    else if (type === 'qa')  await sql`DELETE FROM qa_projects WHERE id = ${id}`;
    else return c.json({ error: 'bad type' }, 400);
    return c.body(null, 204);
  });

  // ---------- API: enable/disable ----------
  app.patch('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (bool) required' }, 400);
    if (type === 'url')      await sql`UPDATE url_monitors SET enabled = ${body.enabled} WHERE id = ${id}`;
    else if (type === 'api') await sql`UPDATE api_checks SET enabled = ${body.enabled} WHERE id = ${id}`;
    else if (type === 'qa')  await sql`UPDATE qa_projects SET enabled = ${body.enabled} WHERE id = ${id}`;
    else return c.json({ error: 'bad type' }, 400);
    return c.body(null, 204);
  });

  // ---------- API: run now ----------
  app.post('/api/monitors/:type/:id/run', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (type === 'url') {
      const [m] = await sql`SELECT * FROM url_monitors WHERE id = ${id}`;
      if (!m) return c.json({ error: 'not found' }, 404);
      const assertions = await sql`SELECT id, operator, status_code FROM url_monitor_assertions WHERE url_monitor_id = ${id}`;
      const [exec] = await sql`INSERT INTO url_monitor_executions (url_monitor_id, status) VALUES (${id}, 'pending') RETURNING id`;
      await urlQ.add('check', { executionId: exec.id, monitor: { id: m.id, url: m.url, timeout_ms: m.timeout_ms }, assertions });
      return c.json({ executionId: exec.id });
    }
    if (type === 'api') {
      const [m] = await sql`SELECT * FROM api_checks WHERE id = ${id}`;
      if (!m) return c.json({ error: 'not found' }, 404);
      const assertions = await sql`SELECT id, type, operator, path, value FROM api_assertions WHERE api_check_id = ${id}`;
      const [exec] = await sql`INSERT INTO api_executions (api_check_id, status) VALUES (${id}, 'pending') RETURNING id`;
      await apiQ.add('check', { executionId: exec.id, apiCheck: m, assertions });
      return c.json({ executionId: exec.id });
    }
    if (type === 'qa') {
      const [m] = await sql`SELECT * FROM qa_projects WHERE id = ${id}`;
      if (!m) return c.json({ error: 'not found' }, 404);
      const tests = await sql`SELECT id, test_name AS name, script FROM qa_generated_tests WHERE project_id = ${id}`;
      if (tests.length === 0) return c.json({ error: 'no tests on this project' }, 400);
      await qaQ.add('run', {
        type: 'qa-project-run',
        project_id: m.id,
        target_url: m.target_url,
        credentials: m.credentials ?? undefined,
        config: m.config ?? {},
        tests,
        triggered_at: new Date().toISOString(),
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

    for (const u of (body.url_monitors ?? []) as any[]) {
      try {
        const [m] = await sql`
          INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
          VALUES (${u.name}, ${u.url}, ${u.timeout_ms ?? 30000}, ${u.interval_seconds ?? 60}, ${u.enabled ?? true})
          RETURNING id
        `;
        for (const a of u.assertions ?? []) {
          await sql`INSERT INTO url_monitor_assertions (url_monitor_id, operator, status_code) VALUES (${m.id}, ${a.operator}, ${a.status_code})`;
        }
        created.url++;
      } catch (err) {
        created.skipped.push(`url ${u.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const a of (body.api_checks ?? []) as any[]) {
      try {
        const [m] = await sql`
          INSERT INTO api_checks (name, url, method, headers, body, timeout_ms, interval_seconds, enabled)
          VALUES (${a.name}, ${a.url}, ${a.method ?? 'GET'}, ${a.headers ?? {}}, ${a.body ?? null}, ${a.timeout_ms ?? 10000}, ${a.interval_seconds ?? 60}, ${a.enabled ?? true})
          RETURNING id
        `;
        for (const ass of a.assertions ?? []) {
          await sql`INSERT INTO api_assertions (api_check_id, type, operator, path, value) VALUES (${m.id}, ${ass.type}, ${ass.operator}, ${ass.path ?? null}, ${ass.value ?? null})`;
        }
        created.api++;
      } catch (err) {
        created.skipped.push(`api ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const q of (body.qa_projects ?? []) as any[]) {
      try {
        const [m] = await sql`
          INSERT INTO qa_projects (name, target_url, credentials, config, interval_seconds, enabled, status)
          VALUES (${q.name}, ${q.target_url}, ${q.credentials ?? null}, ${q.config ?? {}}, ${q.interval_seconds ?? 300}, ${q.enabled ?? true}, 'active')
          RETURNING id
        `;
        for (const t of q.tests ?? []) {
          await sql`INSERT INTO qa_generated_tests (project_id, test_name, test_type, script, description) VALUES (${m.id}, ${t.name}, 'browser', ${t.script}, ${t.description ?? null})`;
        }
        created.qa++;
      } catch (err) {
        created.skipped.push(`qa ${q.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return c.json(created);
  });

  // ---------- static UI ----------
  app.get('/', (c) => {
    const p = join(PUBLIC_DIR, 'index.html');
    if (!existsSync(p)) return c.text('UI not built — run `bun run build:ui`', 500);
    return c.html(readFileSync(p, 'utf8'));
  });
  app.get('/app.js', (c) => {
    const p = join(PUBLIC_DIR, 'app.js');
    if (!existsSync(p)) return c.text('// not built', 404);
    return c.body(readFileSync(p), 200, { 'content-type': 'application/javascript' });
  });

  return { app, close: async () => { await Promise.all([urlQ.close(), apiQ.close(), qaQ.close()]); } };
}

export function startServer(connection: Redis, port: number) {
  const { app, close } = buildApp(connection);
  const server = Bun.serve({ port, fetch: app.fetch });
  logger.info(`🌐 server listening on http://localhost:${port}`);
  return async () => { server.stop(); await close(); };
}
