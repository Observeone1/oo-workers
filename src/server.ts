/**
 * HTTP server: REST API + static UI.
 * Runs in the same process as workers + scheduler.
 */

import { Hono } from 'hono';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULTS } from './constants.ts';
import { urlMonitorRepo } from './db/repositories/url-monitor.repo.ts';
import { apiCheckRepo } from './db/repositories/api-check.repo.ts';
import { qaProjectRepo } from './db/repositories/qa-project.repo.ts';
import { tcpMonitorRepo } from './db/repositories/tcp-monitor.repo.ts';
import { udpMonitorRepo } from './db/repositories/udp-monitor.repo.ts';
import { parseHexPayload } from './services/udp-probe.ts';
import {
  extractKey,
  requireAgent,
  requireAuth,
  SESSION_COOKIE,
  validateKey,
} from './middleware/auth.ts';
import {
  popJobForRegion,
  writeAgentResult,
  type AgentResultBody,
} from './services/agent-dispatch.ts';
import { monitorRegionRepo, regionRepo, type MonitorType } from './db/repositories/region.repo.ts';
import {
  alertChannelRepo,
  monitorAlertChannelRepo,
  type ChannelType,
} from './db/repositories/alert-channel.repo.ts';
import { sendToChannel } from './services/alert-dispatch.ts';
import {
  createRegionWithKey,
  deleteRegion,
  RegionAdminError,
  rotateRegionKey,
} from './services/region-admin.ts';
import { logger } from './utils/logger.ts';

const MONITOR_TYPES: readonly MonitorType[] = ['url', 'api', 'tcp', 'udp', 'qa'];

const PUBLIC_DIR = resolve(import.meta.dir, '../public');

function loadText(name: string): string | null {
  const p = join(PUBLIC_DIR, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}
const ASSETS = {
  indexHtml: loadText('index.html'),
  appJs: loadText('app.js'),
  docsHtml: loadText('docs.html'),
  tokensCss: loadText('tokens.css'),
  dashboardCss: loadText('dashboard.css'),
  docsCss: loadText('docs.css'),
};

function buildApp(connection: Redis) {
  const app = new Hono();
  const urlQ = new Queue('url-monitor', { connection });
  const apiQ = new Queue('api-check', { connection });
  const qaQ = new Queue('qa-project', { connection });
  const tcpQ = new Queue('tcp-monitor', { connection });
  const udpQ = new Queue('udp-monitor', { connection });

  // Dedicated connection for blocking pops in /api/agent/jobs. BRPOP holds
  // the connection for the duration of the wait, so it must not share with
  // the BullMQ Queue ops above.
  const blockingConn = connection.duplicate();

  // ---------- Auth ----------
  // Gate every write under /api/monitors and /api/import behind requireAuth.
  // Reads (GET) stay open — they don't leak secrets, only metadata.
  const writeAuth = requireAuth('write');
  app.use('/api/monitors/*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    return writeAuth(c, next);
  });
  app.use('/api/import', writeAuth);
  app.use('/api/channels/*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    return writeAuth(c, next);
  });
  app.use('/api/regions/*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    return writeAuth(c, next);
  });

  // POST /api/auth/login — body { key }. On match, sets HttpOnly cookie.
  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key = typeof body.key === 'string' ? body.key.trim() : '';
    if (!key) return c.json({ error: 'key required' }, 400);
    const row = await validateKey(key);
    if (!row) return c.json({ error: 'invalid or revoked key' }, 401);
    // 30-day cookie. Secure flag flips on when TLS overlay is in front (S4).
    const maxAge = 60 * 60 * 24 * 30;
    c.header(
      'set-cookie',
      `${SESSION_COOKIE}=${key}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
    );
    return c.json({ name: row.name, prefix: row.keyPrefix, scopes: row.scopes });
  });

  // POST /api/auth/logout — clears the cookie.
  app.post('/api/auth/logout', (c) => {
    c.header('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return c.body(null, 204);
  });

  // GET /api/auth/me — the dashboard uses this to decide login screen vs app.
  app.get('/api/auth/me', async (c) => {
    const cleartext = extractKey(c);
    if (!cleartext) return c.json({ error: 'not authenticated' }, 401);
    const row = await validateKey(cleartext);
    if (!row) return c.json({ error: 'invalid or revoked key' }, 401);
    return c.json({ name: row.name, prefix: row.keyPrefix, scopes: row.scopes });
  });

  // ---------- API: list ----------
  app.get('/api/monitors', async (c) => {
    const [urls, apis, qas, tcps, udps] = await Promise.all([
      urlMonitorRepo.findAllWithLatest(),
      apiCheckRepo.findAllWithLatest(),
      qaProjectRepo.findAllWithLatest(),
      tcpMonitorRepo.findAllWithLatest(),
      udpMonitorRepo.findAllWithLatest(),
    ]);
    return c.json({ url: urls, api: apis, qa: qas, tcp: tcps, udp: udps });
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
    if (type === 'tcp') {
      const [m] = await tcpMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const runs = await tcpMonitorRepo.findExecutionsByMonitorId(id);
      return c.json({
        monitor: { ...m, type: 'tcp' },
        runs: runs.map((r) => ({ ...r, responseTimeMs: r.latencyMs })),
      });
    }
    if (type === 'udp') {
      const [m] = await udpMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const runs = await udpMonitorRepo.findExecutionsByMonitorId(id);
      return c.json({
        monitor: { ...m, type: 'udp' },
        runs: runs.map((r) => ({ ...r, responseTimeMs: r.latencyMs })),
      });
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
      timeoutMs: body.timeoutMs ?? DEFAULTS.URL_TIMEOUT_MS,
      intervalSeconds: body.intervalSeconds ?? 60,
      enabled: body.enabled ?? true,
    });
    const assertions = (body.assertions ?? []) as Array<{ operator: string; statusCode: number }>;
    await urlMonitorRepo.createAssertions(
      m.id,
      assertions.map((a) => ({ operator: a.operator, statusCode: a.statusCode })),
    );
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
      timeoutMs: body.timeoutMs ?? DEFAULTS.API_TIMEOUT_IMPORT_DEFAULT_MS,
      intervalSeconds: body.intervalSeconds ?? 60,
      enabled: body.enabled ?? true,
    });
    const assertions = (body.assertions ?? []) as Array<{
      type: string;
      operator: string;
      path?: string;
      value?: string;
    }>;
    await apiCheckRepo.createAssertions(
      m.id,
      assertions.map((a) => ({
        type: a.type,
        operator: a.operator,
        path: a.path ?? null,
        value: a.value ?? null,
      })),
    );
    return c.json(m, 201);
  });

  app.post('/api/monitors/tcp', async (c) => {
    const body = await c.req.json();
    const port = Number(body.port);
    if (!body.name || !body.host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ error: 'name + host + port (1-65535) required' }, 400);
    }
    const [m] = await tcpMonitorRepo.create({
      name: body.name,
      host: body.host,
      port,
      timeoutMs: body.timeoutMs ?? DEFAULTS.TCP_TIMEOUT_MS,
      intervalSeconds: body.intervalSeconds ?? 60,
      enabled: body.enabled ?? true,
    });
    return c.json(m, 201);
  });

  app.post('/api/monitors/udp', async (c) => {
    const body = await c.req.json();
    const port = Number(body.port);
    if (!body.name || !body.host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ error: 'name + host + port (1-65535) required' }, 400);
    }
    if (body.payloadHex) {
      try {
        parseHexPayload(body.payloadHex);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : 'invalid payloadHex' }, 400);
      }
    }
    const [m] = await udpMonitorRepo.create({
      name: body.name,
      host: body.host,
      port,
      payloadHex: body.payloadHex ?? null,
      expectResponse: body.expectResponse ?? false,
      timeoutMs: body.timeoutMs ?? DEFAULTS.UDP_TIMEOUT_MS,
      intervalSeconds: body.intervalSeconds ?? 60,
      enabled: body.enabled ?? true,
    });
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
      intervalSeconds: body.intervalSeconds ?? DEFAULTS.QA_INTERVAL_SECONDS,
      enabled: body.enabled ?? true,
      status: 'active',
    });
    const tests = body.tests as Array<{ name: string; script: string; description?: string }>;
    await qaProjectRepo.createTests(
      m.id,
      tests.map((t) => ({
        testName: t.name,
        testType: 'browser',
        script: t.script,
        description: t.description ?? null,
      })),
    );
    return c.json(m, 201);
  });

  // ---------- API: delete ----------
  app.delete('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type') as MonitorType;
    const id = Number(c.req.param('id'));
    if (type === 'url') await urlMonitorRepo.deleteById(id);
    else if (type === 'api') await apiCheckRepo.deleteById(id);
    else if (type === 'qa') await qaProjectRepo.deleteById(id);
    else if (type === 'tcp') await tcpMonitorRepo.deleteById(id);
    else if (type === 'udp') await udpMonitorRepo.deleteById(id);
    else return c.json({ error: 'bad type' }, 400);
    // monitor_alert_channels has no real FK (different monitor types live in
    // different tables) — clean it up application-side so dangling rows don't
    // misroute alerts for future monitors with the same id.
    await monitorAlertChannelRepo.clearForMonitor(type, id);
    return c.body(null, 204);
  });

  // ---------- API: monitor regions ----------
  // Replace the full set of regions attached to a monitor. Empty array =
  // run on master. Until M3 ships the UI selector, this is how operators
  // bind regions programmatically.
  app.put('/api/monitors/:type/:id/regions', async (c) => {
    const type = c.req.param('type') as MonitorType;
    const id = Number(c.req.param('id'));
    if (!MONITOR_TYPES.includes(type)) return c.json({ error: 'bad type' }, 400);
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (
      !Array.isArray(body.regionIds) ||
      !body.regionIds.every((n: unknown) => Number.isInteger(n))
    ) {
      return c.json({ error: 'regionIds must be an integer array' }, 400);
    }
    await monitorRegionRepo.set(type, id, body.regionIds as number[]);
    return c.json({ ok: true, regionIds: body.regionIds });
  });

  // ---------- API: monitor alert channels ----------
  // Replace the full set of alert channels bound to a monitor. Empty array =
  // no alert routing. Same shape as the regions endpoint above.
  app.put('/api/monitors/:type/:id/channels', async (c) => {
    const type = c.req.param('type') as MonitorType;
    const id = Number(c.req.param('id'));
    if (!MONITOR_TYPES.includes(type)) return c.json({ error: 'bad type' }, 400);
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json().catch(() => ({}));
    if (
      !Array.isArray(body.channelIds) ||
      !body.channelIds.every((n: unknown) => Number.isInteger(n))
    ) {
      return c.json({ error: 'channelIds must be an integer array' }, 400);
    }
    await monitorAlertChannelRepo.set(type, id, body.channelIds as number[]);
    return c.json({ ok: true, channelIds: body.channelIds });
  });

  // ---------- API: enable/disable ----------
  app.patch('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    const body = await c.req.json();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (bool) required' }, 400);
    if (type === 'url') await urlMonitorRepo.updateEnabled(id, body.enabled);
    else if (type === 'api') await apiCheckRepo.updateEnabled(id, body.enabled);
    else if (type === 'qa') await qaProjectRepo.updateEnabled(id, body.enabled);
    else if (type === 'tcp') await tcpMonitorRepo.updateEnabled(id, body.enabled);
    else if (type === 'udp') await udpMonitorRepo.updateEnabled(id, body.enabled);
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
      await urlQ.add('check', {
        executionId: exec.id,
        monitor: { id: m.id, url: m.url, timeoutMs: m.timeoutMs },
        assertions,
      });
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
      const tests = await qaProjectRepo.findTestsByProjectId(id, { includeScript: true });
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
    if (type === 'tcp') {
      const [m] = await tcpMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const [exec] = await tcpMonitorRepo.createExecution(id, 'PENDING');
      await tcpQ.add('check', {
        executionId: exec.id,
        monitor: { id: m.id, host: m.host, port: m.port, timeoutMs: m.timeoutMs },
      });
      return c.json({ executionId: exec.id });
    }
    if (type === 'udp') {
      const [m] = await udpMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const [exec] = await udpMonitorRepo.createExecution(id, 'PENDING');
      await udpQ.add('check', {
        executionId: exec.id,
        monitor: {
          id: m.id,
          host: m.host,
          port: m.port,
          payloadHex: m.payloadHex,
          expectResponse: m.expectResponse,
          timeoutMs: m.timeoutMs,
        },
      });
      return c.json({ executionId: exec.id });
    }
    return c.json({ error: 'bad type' }, 400);
  });

  // ---------- API: bulk import ----------
  app.post('/api/import', async (c) => {
    const body = await c.req.json();
    if (body.version !== 1) return c.json({ error: 'unsupported import version' }, 400);
    const created = { url: 0, api: 0, qa: 0, tcp: 0, udp: 0, skipped: [] as string[] };

    for (const u of (body.urlMonitors ?? []) as any[]) {
      try {
        const [m] = await urlMonitorRepo.create({
          name: u.name,
          url: u.url,
          timeoutMs: u.timeoutMs ?? DEFAULTS.URL_TIMEOUT_MS,
          intervalSeconds: u.intervalSeconds ?? 60,
          enabled: u.enabled ?? true,
        });
        await urlMonitorRepo.createAssertions(
          m.id,
          (u.assertions ?? []).map((a: any) => ({
            operator: a.operator,
            statusCode: a.statusCode,
          })),
        );
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
          timeoutMs: a.timeoutMs ?? DEFAULTS.API_TIMEOUT_IMPORT_DEFAULT_MS,
          intervalSeconds: a.intervalSeconds ?? 60,
          enabled: a.enabled ?? true,
        });
        await apiCheckRepo.createAssertions(
          m.id,
          (a.assertions ?? []).map((ass: any) => ({
            type: ass.type,
            operator: ass.operator,
            path: ass.path ?? null,
            value: ass.value ?? null,
          })),
        );
        created.api++;
      } catch (err) {
        created.skipped.push(`api ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const t of (body.tcpMonitors ?? []) as any[]) {
      try {
        await tcpMonitorRepo.create({
          name: t.name,
          host: t.host,
          port: Number(t.port),
          timeoutMs: t.timeoutMs ?? DEFAULTS.TCP_TIMEOUT_MS,
          intervalSeconds: t.intervalSeconds ?? 60,
          enabled: t.enabled ?? true,
        });
        created.tcp++;
      } catch (err) {
        created.skipped.push(`tcp ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const u of (body.udpMonitors ?? []) as any[]) {
      try {
        if (u.payloadHex) parseHexPayload(u.payloadHex);
        await udpMonitorRepo.create({
          name: u.name,
          host: u.host,
          port: Number(u.port),
          payloadHex: u.payloadHex ?? null,
          expectResponse: u.expectResponse ?? false,
          timeoutMs: u.timeoutMs ?? DEFAULTS.UDP_TIMEOUT_MS,
          intervalSeconds: u.intervalSeconds ?? 60,
          enabled: u.enabled ?? true,
        });
        created.udp++;
      } catch (err) {
        created.skipped.push(`udp ${u.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    for (const q of (body.qaProjects ?? []) as any[]) {
      try {
        const [m] = await qaProjectRepo.create({
          name: q.name,
          targetUrl: q.targetUrl,
          credentials: q.credentials ?? null,
          config: q.config ?? {},
          intervalSeconds: q.intervalSeconds ?? DEFAULTS.QA_INTERVAL_SECONDS,
          enabled: q.enabled ?? true,
          status: 'active',
        });
        await qaProjectRepo.createTests(
          m.id,
          (q.tests ?? []).map((t: any) => ({
            testName: t.name,
            testType: 'browser',
            script: t.script,
            description: t.description ?? null,
          })),
        );
        created.qa++;
      } catch (err) {
        created.skipped.push(`qa ${q.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return c.json(created);
  });

  // ---------- Regions (multi-region admin) ----------
  // A region is "online" if its last_seen_at is within ONLINE_THRESHOLD_MS.
  // Long-poll traffic refreshes last_seen_at every poll, so an offline
  // agent shows up here within a minute.
  const ONLINE_THRESHOLD_MS = 60_000;

  app.get('/api/regions', async (c) => {
    const rows = await regionRepo.list();
    const now = Date.now();
    return c.json(
      rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        label: r.label,
        lastSeenAt: r.lastSeenAt,
        createdAt: r.createdAt,
        online: r.lastSeenAt ? now - r.lastSeenAt.getTime() < ONLINE_THRESHOLD_MS : false,
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

  // ---------- Alert channels (Phase 5) ----------
  const VALID_CHANNEL_TYPES: ChannelType[] = ['webhook', 'discord', 'slack'];

  app.get('/api/channels', async (c) => {
    const rows = await alertChannelRepo.list();
    return c.json(rows);
  });

  app.post('/api/channels', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const type = typeof body.type === 'string' ? body.type : '';
    const url = typeof body.url === 'string' ? body.url.trim() : '';
    if (!name) return c.json({ error: 'name is required' }, 400);
    if (!VALID_CHANNEL_TYPES.includes(type as ChannelType)) {
      return c.json({ error: `type must be one of ${VALID_CHANNEL_TYPES.join(', ')}` }, 400);
    }
    if (!url || !/^https?:\/\//i.test(url)) {
      return c.json({ error: 'url is required (http:// or https://)' }, 400);
    }
    const [row] = await alertChannelRepo.create({
      name,
      type: type as ChannelType,
      config: { url },
    });
    return c.json(row, 201);
  });

  app.delete('/api/channels/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const existing = await alertChannelRepo.findById(id);
    if (!existing) return c.json({ error: 'not found' }, 404);
    await alertChannelRepo.deleteById(id);
    return c.body(null, 204);
  });

  // Send a test payload through the channel. Helpful before binding it to
  // any monitor — operator pastes the URL, clicks Test, and confirms the
  // alert lands in Discord/Slack/etc. before plumbing it into production.
  app.post('/api/channels/:id/test', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const channel = await alertChannelRepo.findById(id);
    if (!channel) return c.json({ error: 'not found' }, 404);
    const ok = await sendToChannel(channel, {
      monitor: {
        type: 'url',
        id: 0,
        name: 'oo-workers test alert',
        target: 'https://example.com',
      },
      event: 'test',
      status: 'TEST',
      statusCode: 200,
      errorMessage: 'This is a test alert from the oo-workers dashboard. Ignore.',
      durationMs: 42,
      startTime: new Date().toISOString(),
      regionSlug: null,
    });
    if (!ok) return c.json({ ok: false, error: 'channel delivery failed; check worker logs' }, 502);
    return c.json({ ok: true });
  });

  // ---------- Agent (multi-region) ----------
  //
  // Diagnostic endpoint — confirms the agent key is valid + bound, and
  // returns the region it's bound to so the preflight CLI can flag
  // OO_REGION_SLUG / key mismatches before the agent goes live.
  app.get('/api/agent/me', requireAgent(), async (c) => {
    const region = c.get('region');
    return c.json({ region: { id: region.id, slug: region.slug, label: region.label } });
  });

  // Long-poll endpoint — agent calls this repeatedly, master holds the
  // connection open until a job is available or `wait` seconds pass.
  // Returns 204 on timeout (agent reconnects). On 200, the body is the
  // job payload, including `type`, `executionId`, `regionId`, and the
  // type-specific monitor fields the agent's probe needs.
  app.get('/api/agent/jobs', requireAgent(), async (c) => {
    const region = c.get('region');
    const waitRaw = c.req.query('wait');
    const wait = Math.min(60, Math.max(1, waitRaw ? Number.parseInt(waitRaw, 10) || 30 : 30));
    const payload = await popJobForRegion(blockingConn, region.slug, wait);
    if (!payload) return c.body(null, 204);
    return c.json(payload);
  });

  // POST /api/agent/results — agent posts back the probe result. The
  // executions row must reference the agent's region or the write is
  // rejected (403). Idempotent on executionId — a second POST for the
  // same exec is silently dropped (rows.updated=false because the
  // status no longer matches PENDING semantics here we only filter on
  // region_id, but a re-update simply rewrites the same values).
  app.post('/api/agent/results', requireAgent(), async (c) => {
    const region = c.get('region');
    let body: AgentResultBody;
    try {
      body = (await c.req.json()) as AgentResultBody;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    if (!body.type || typeof body.executionId !== 'number' || !body.status) {
      return c.json({ error: 'type, executionId, status are required' }, 400);
    }
    const outcome = await writeAgentResult(region.id, body);
    if (!outcome.updated) {
      return c.json(
        { error: 'execution not found or not owned by this region', reason: outcome.reason },
        403,
      );
    }
    logger.info(
      `agent result region=${region.slug} type=${body.type} exec=${body.executionId} status=${body.status}`,
    );
    return c.json({ ok: true });
  });

  // ---------- static UI ----------
  app.get('/', (c) =>
    ASSETS.indexHtml
      ? c.html(ASSETS.indexHtml)
      : c.text('UI not built — run `bun run build:ui`', 500),
  );
  app.get('/app.js', (c) =>
    ASSETS.appJs
      ? c.body(ASSETS.appJs, 200, { 'content-type': 'application/javascript' })
      : c.text('// not built', 404),
  );
  app.get('/docs', (c) =>
    ASSETS.docsHtml ? c.html(ASSETS.docsHtml) : c.text('docs not built', 500),
  );
  const serveCss = (body: string | null) => (c: import('hono').Context) =>
    body ? c.body(body, 200, { 'content-type': 'text/css' }) : c.text('/* not built */', 404);
  app.get('/tokens.css', serveCss(ASSETS.tokensCss));
  app.get('/dashboard.css', serveCss(ASSETS.dashboardCss));
  app.get('/docs.css', serveCss(ASSETS.docsCss));

  return {
    app,
    close: async () => {
      await Promise.all([urlQ.close(), apiQ.close(), qaQ.close(), tcpQ.close(), udpQ.close()]);
      await blockingConn.quit().catch(() => {});
    },
  };
}

export function startServer(connection: Redis, port: number) {
  const { app, close } = buildApp(connection);
  // idleTimeout default is 10s — too short for agent long-polls (up to 60s).
  // Bumping to 120s gives ample headroom; the agent's BRPOP wait is capped
  // at 60s in /api/agent/jobs so this only closes truly dead connections.
  const server = Bun.serve({ port, fetch: app.fetch, idleTimeout: 120 });
  logger.info(`🌐 server listening on http://localhost:${port}`);
  return async () => {
    server.stop();
    await close();
  };
}
