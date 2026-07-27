/**
 * /api/monitors/* + /api/availability — every monitor type's list, detail,
 * create, delete, enable/disable, regions binding, channels binding, and
 * run-now. Heartbeat create + patch include the periodSeconds ≥ 30 +
 * graceSeconds ≥ 0 guards. TLS create validates expect_cn_regex at save
 * (ReDoS-bounded by length + a trivially-nested-quantifier denylist).
 */
import type { Hono } from 'hono';
import { DEFAULTS } from '../constants.ts';
import { urlMonitorRepo } from '../db/repositories/url-monitor.repo.ts';
import { apiCheckRepo } from '../db/repositories/api-check.repo.ts';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import { tcpMonitorRepo } from '../db/repositories/tcp-monitor.repo.ts';
import { udpMonitorRepo } from '../db/repositories/udp-monitor.repo.ts';
import { dbMonitorRepo } from '../db/repositories/db-monitor.repo.ts';
import { tlsMonitorRepo } from '../db/repositories/tls-monitor.repo.ts';
import { heartbeatRepo } from '../db/repositories/heartbeat.repo.ts';
import { parseHexPayload } from '../services/udp-probe.ts';
import { monitorRegionRepo, type MonitorType } from '../db/repositories/region.repo.ts';
import { monitorAlertChannelRepo } from '../db/repositories/alert-channel.repo.ts';
import { statusPageMonitorRepo } from '../db/repositories/status-page.repo.ts';
import { getFleetAvailability } from '../db/repositories/availability.repo.ts';
import { emitMonitorCreated, emitMonitorDeleted } from '../services/exec-events.ts';
import type { RouteDeps } from './types.ts';

const MONITOR_TYPES: ReadonlySet<MonitorType> = new Set([
  'url',
  'api',
  'tcp',
  'udp',
  'qa',
  'db',
  'tls',
]);

// Must match the enums in src/services/api-assertion.ts. The api_assertions
// table has NOT NULL on (type, operator), so an invalid value used to land as
// a Postgres constraint error → 500. Validating here returns a useful 400.
const VALID_ASSERTION_TYPES = new Set([
  'status_code',
  'response_time',
  'json_path',
  'text_contains',
  'header',
]);
const VALID_ASSERTION_OPERATORS = new Set([
  'equals',
  'not_equals',
  'less_than',
  'greater_than',
  'contains',
  'not_contains',
  'exists',
]);

function badPort(port: number): boolean {
  return !Number.isInteger(port) || port < 1 || port > 65535;
}

function validatePayloadHex(hex: unknown): string | null {
  if (!hex) return null;
  try {
    parseHexPayload(hex as string);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid payloadHex';
  }
}

export function registerMonitorRoutes(app: Hono, deps: RouteDeps): void {
  const { urlQ, apiQ, qaQ, tcpQ, udpQ, dbQ, tlsQ } = deps;

  // ---------- API: list ----------
  app.get('/api/monitors', async (c) => {
    const [urls, apis, qas, tcps, udps, dbs, tlss, hbs] = await Promise.all([
      urlMonitorRepo.findAllWithLatest(),
      apiCheckRepo.findAllWithLatest(),
      qaProjectRepo.findAllWithLatest(),
      tcpMonitorRepo.findAllWithLatest(),
      udpMonitorRepo.findAllWithLatest(),
      dbMonitorRepo.findAllWithLatest(),
      tlsMonitorRepo.findAllWithLatest(),
      heartbeatRepo.list(),
    ]);
    return c.json({
      url: urls,
      api: apis,
      qa: qas,
      tcp: tcps,
      udp: udps,
      db: dbs,
      tls: tlss,
      heartbeat: hbs,
    });
  });

  // ---------- API: fleet availability ----------
  app.get('/api/availability', async (c) => {
    const days = Math.min(90, Math.max(1, Number(c.req.query('days') ?? 30)));
    const buckets = await getFleetAvailability(days);
    return c.json(buckets);
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
    if (type === 'db') {
      const [m] = await dbMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const runs = await dbMonitorRepo.findExecutionsByMonitorId(id);
      return c.json({
        monitor: { ...m, type: 'db' },
        runs: runs.map((r) => ({ ...r, responseTimeMs: r.latencyMs })),
      });
    }
    if (type === 'tls') {
      const [m] = await tlsMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const runs = await tlsMonitorRepo.findExecutionsByMonitorId(id);
      return c.json({
        monitor: { ...m, type: 'tls' },
        runs: runs.map((r) => ({ ...r, responseTimeMs: r.latencyMs })),
      });
    }
    if (type === 'heartbeat') {
      const [m] = await heartbeatRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      return c.json({ monitor: { ...m, type: 'heartbeat' }, runs: [] });
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
    emitMonitorCreated('url', m.id);
    return c.json(m, 201);
  });

  app.post('/api/monitors/api', async (c) => {
    const body = await c.req.json();
    if (!body.name || !body.url) return c.json({ error: 'name + url required' }, 400);
    const rawAssertions = (body.assertions ?? []) as unknown;
    if (!Array.isArray(rawAssertions)) {
      return c.json({ error: 'assertions must be an array' }, 400);
    }
    for (let i = 0; i < rawAssertions.length; i++) {
      const a = rawAssertions[i] as { type?: unknown; operator?: unknown };
      if (!a || typeof a !== 'object') {
        return c.json({ error: `assertions[${i}] must be an object` }, 400);
      }
      if (typeof a.type !== 'string' || !VALID_ASSERTION_TYPES.has(a.type)) {
        return c.json(
          {
            error: `assertions[${i}].type must be one of: ${[...VALID_ASSERTION_TYPES].join(', ')}`,
          },
          400,
        );
      }
      if (typeof a.operator !== 'string' || !VALID_ASSERTION_OPERATORS.has(a.operator)) {
        return c.json(
          {
            error: `assertions[${i}].operator must be one of: ${[...VALID_ASSERTION_OPERATORS].join(', ')}`,
          },
          400,
        );
      }
    }
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
    const assertions = rawAssertions as Array<{
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
    emitMonitorCreated('api', m.id);
    return c.json(m, 201);
  });

  app.post('/api/monitors/tcp', async (c) => {
    const body = await c.req.json();
    const port = Number(body.port);
    if (!body.name || !body.host || badPort(port))
      return c.json({ error: 'name + host + port (1-65535) required' }, 400);
    const hexErr = validatePayloadHex(body.payloadHex);
    if (hexErr) return c.json({ error: hexErr }, 400);
    const [m] = await tcpMonitorRepo.create({
      name: body.name,
      host: body.host,
      port,
      payloadHex: body.payloadHex ?? null,
      expectBanner: body.expectBanner ?? null,
      timeoutMs: body.timeoutMs ?? DEFAULTS.TCP_TIMEOUT_MS,
      intervalSeconds: body.intervalSeconds ?? 60,
      enabled: body.enabled ?? true,
    });
    emitMonitorCreated('tcp', m.id);
    return c.json(m, 201);
  });

  app.post('/api/monitors/udp', async (c) => {
    const body = await c.req.json();
    const port = Number(body.port);
    if (!body.name || !body.host || badPort(port))
      return c.json({ error: 'name + host + port (1-65535) required' }, 400);
    const hexErr = validatePayloadHex(body.payloadHex);
    if (hexErr) return c.json({ error: hexErr }, 400);
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
    emitMonitorCreated('udp', m.id);
    return c.json(m, 201);
  });

  app.post('/api/monitors/db', async (c) => {
    const body = await c.req.json();
    const port = Number(body.port);
    const protocol = body.protocol;
    if (!body.name || !body.host || badPort(port))
      return c.json({ error: 'name + host + port (1-65535) required' }, 400);
    if (protocol !== 'postgres' && protocol !== 'mysql' && protocol !== 'redis') {
      return c.json({ error: 'protocol must be postgres, mysql, or redis' }, 400);
    }
    const [m] = await dbMonitorRepo.create({
      name: body.name,
      protocol,
      host: body.host,
      port,
      tls: body.tls === true,
      timeoutMs: body.timeoutMs ?? DEFAULTS.DB_TIMEOUT_MS,
      intervalSeconds: body.intervalSeconds ?? 60,
      enabled: body.enabled ?? true,
    });
    emitMonitorCreated('db', m.id);
    return c.json(m, 201);
  });

  app.post('/api/monitors/tls', async (c) => {
    const body = await c.req.json();
    const port = body.port == null ? 443 : Number(body.port);
    if (!body.name || !body.host || badPort(port))
      return c.json({ error: 'name + host (+ optional port 1-65535) required' }, 400);
    const warnDays = body.warnDays == null ? 30 : Number(body.warnDays);
    if (!Number.isInteger(warnDays) || warnDays < 0) {
      return c.json({ error: 'warnDays must be a non-negative integer' }, 400);
    }
    // Validate expect_cn_regex AT SAVE — a bad/ReDoS pattern must not be
    // saveable (else it fails every probe forever). Probe-time has a
    // try/catch backstop, but this is the gate.
    let expectCnRegex: string | null = null;
    if (body.expectCnRegex != null && String(body.expectCnRegex).length > 0) {
      const raw = String(body.expectCnRegex);
      if (raw.length > 200) {
        return c.json({ error: 'expectCnRegex too long (max 200 chars)' }, 400);
      }
      // The 200-char cap above is the PRIMARY ReDoS bound. This denylist
      // is a bonus that rejects only the trivially-nested-quantifier
      // footgun (a quantified group immediately re-quantified, e.g.
      // (a+)+ (.*)* (a*)+). It does NOT claim to catch every ReDoS shape
      // (alternation overlap etc. is not detected — that's the cap's job).
      if (/\([^()]*[+*][^()]*\)[+*]/.test(raw)) {
        return c.json(
          { error: 'expectCnRegex has a trivially-nested quantifier (e.g. (a+)+); rewrite it' },
          400,
        );
      }
      try {
        new RegExp(raw);
      } catch (e) {
        return c.json(
          { error: `expectCnRegex is not a valid regex: ${e instanceof Error ? e.message : e}` },
          400,
        );
      }
      expectCnRegex = raw;
    }
    const [m] = await tlsMonitorRepo.create({
      name: body.name,
      host: body.host,
      port,
      servername: body.servername || null,
      warnDays,
      intervalSeconds: body.intervalSeconds ?? 60,
      enabled: body.enabled ?? true,
      verifyChain: body.verifyChain === true,
      verifyHostname: body.verifyHostname === true,
      expectCnRegex,
    });
    emitMonitorCreated('tls', m.id);
    return c.json(m, 201);
  });

  // Heartbeat — inverted-direction (service pings us). Create returns
  // the token in the body since the operator needs the public URL to
  // wire into their cron/service. The token is also visible on subsequent
  // GETs (it's not a secret; it's a URL component).
  app.post('/api/monitors/heartbeat', async (c) => {
    const body = await c.req.json();
    if (!body.name || typeof body.name !== 'string') {
      return c.json({ error: 'name is required' }, 400);
    }
    const period = Number(body.periodSeconds);
    if (!Number.isFinite(period) || period < 30) {
      return c.json({ error: 'periodSeconds must be a number ≥ 30' }, 400);
    }
    const grace = Number(body.graceSeconds ?? 60);
    if (!Number.isFinite(grace) || grace < 0) {
      return c.json({ error: 'graceSeconds must be a non-negative number' }, 400);
    }
    const [m] = await heartbeatRepo.create({
      name: body.name,
      description: body.description ?? null,
      periodSeconds: period,
      graceSeconds: grace,
      enabled: body.enabled ?? true,
    });
    emitMonitorCreated('heartbeat', m.id);
    return c.json(m, 201);
  });

  app.patch('/api/monitors/heartbeat/:id', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json();
    const update: Record<string, unknown> = {};
    if (typeof body.name === 'string') update.name = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.periodSeconds !== undefined) {
      const p = Number(body.periodSeconds);
      if (!Number.isFinite(p) || p < 30) {
        return c.json({ error: 'periodSeconds must be a number ≥ 30' }, 400);
      }
      update.periodSeconds = p;
    }
    if (body.graceSeconds !== undefined) {
      const g = Number(body.graceSeconds);
      if (!Number.isFinite(g) || g < 0) {
        return c.json({ error: 'graceSeconds must be a non-negative number' }, 400);
      }
      update.graceSeconds = g;
    }
    if (typeof body.enabled === 'boolean') update.enabled = body.enabled;
    const [m] = await heartbeatRepo.update(id, update);
    if (!m) return c.json({ error: 'not found' }, 404);
    return c.json(m);
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
    emitMonitorCreated('qa', m.id);
    return c.json(m, 201);
  });

  // ---------- API: delete ----------
  app.delete('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type') as MonitorType;
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    if (type === 'url') await urlMonitorRepo.deleteById(id);
    else if (type === 'api') await apiCheckRepo.deleteById(id);
    else if (type === 'qa') await qaProjectRepo.deleteById(id);
    else if (type === 'tcp') await tcpMonitorRepo.deleteById(id);
    else if (type === 'udp') await udpMonitorRepo.deleteById(id);
    else if (type === 'db') await dbMonitorRepo.deleteById(id);
    else if (type === 'tls') await tlsMonitorRepo.deleteById(id);
    else if (type === 'heartbeat') await heartbeatRepo.delete(id);
    else return c.json({ error: 'bad type' }, 400);
    // monitor_alert_channels and status_page_monitors have no real FK
    // (different monitor types live in different tables); clean them up
    // application-side so dangling rows don't misroute alerts or surface
    // ghost monitors on status pages.
    await monitorAlertChannelRepo.clearForMonitor(type, id);
    await statusPageMonitorRepo.clearForMonitor(type, id);
    emitMonitorDeleted(type, id);
    return c.body(null, 204);
  });

  // ---------- API: monitor regions ----------
  app.put('/api/monitors/:type/:id/regions', async (c) => {
    const type = c.req.param('type') as MonitorType;
    const id = Number(c.req.param('id'));
    if (!MONITOR_TYPES.has(type)) return c.json({ error: 'bad type' }, 400);
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
  app.put('/api/monitors/:type/:id/channels', async (c) => {
    const type = c.req.param('type') as MonitorType;
    const id = Number(c.req.param('id'));
    if (!MONITOR_TYPES.has(type)) return c.json({ error: 'bad type' }, 400);
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

  // ---------- API: full update ----------
  app.put('/api/monitors/heartbeat/:id', async (c) => {
    // Heartbeat already has a specific PATCH; this PUT is its alias for the
    // unified edit dialog path.
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json();
    const update: Record<string, unknown> = {};
    if (typeof body.name === 'string') update.name = body.name;
    if (body.description !== undefined) update.description = body.description;
    if (body.periodSeconds !== undefined) {
      const p = Number(body.periodSeconds);
      if (!Number.isFinite(p) || p < 30)
        return c.json({ error: 'periodSeconds must be ≥ 30' }, 400);
      update.periodSeconds = p;
    }
    if (body.graceSeconds !== undefined) {
      const g = Number(body.graceSeconds);
      if (!Number.isFinite(g) || g < 0) return c.json({ error: 'graceSeconds must be ≥ 0' }, 400);
      update.graceSeconds = g;
    }
    const [m] = await heartbeatRepo.update(
      id,
      update as Parameters<typeof heartbeatRepo.update>[1],
    );
    if (!m) return c.json({ error: 'not found' }, 404);
    return c.json(m);
  });

  app.put('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json();

    if (type === 'url') {
      if (!body.name || !body.url) return c.json({ error: 'name + url required' }, 400);
      const [m] = await urlMonitorRepo.update(id, {
        name: body.name,
        url: body.url,
        intervalSeconds: body.intervalSeconds ?? 60,
      });
      if (!m) return c.json({ error: 'not found' }, 404);
      if (Array.isArray(body.assertions)) {
        await urlMonitorRepo.replaceAssertions(
          id,
          (body.assertions as Array<{ operator: string; statusCode: number }>).map((a) => ({
            operator: a.operator,
            statusCode: Number(a.statusCode),
          })),
        );
      }
      return c.json(m);
    }
    if (type === 'api') {
      if (!body.name || !body.url) return c.json({ error: 'name + url required' }, 400);
      const rawAssertions = Array.isArray(body.assertions) ? body.assertions : [];
      for (let i = 0; i < rawAssertions.length; i++) {
        const a = rawAssertions[i] as { type?: unknown; operator?: unknown };
        if (!a || typeof a !== 'object')
          return c.json({ error: `assertions[${i}] must be an object` }, 400);
        if (typeof a.type !== 'string' || !VALID_ASSERTION_TYPES.has(a.type))
          return c.json({ error: `assertions[${i}].type invalid` }, 400);
        if (typeof a.operator !== 'string' || !VALID_ASSERTION_OPERATORS.has(a.operator))
          return c.json({ error: `assertions[${i}].operator invalid` }, 400);
      }
      const [m] = await apiCheckRepo.update(id, {
        name: body.name,
        url: body.url,
        method: body.method ?? 'GET',
        intervalSeconds: body.intervalSeconds ?? 60,
      });
      if (!m) return c.json({ error: 'not found' }, 404);
      await apiCheckRepo.replaceAssertions(
        id,
        rawAssertions.map(
          (a: { type: string; operator: string; path?: string; value?: string }) => ({
            type: a.type,
            operator: a.operator,
            path: a.path ?? null,
            value: a.value ?? null,
          }),
        ),
      );
      return c.json(m);
    }
    if (type === 'tcp') {
      const port = Number(body.port);
      if (!body.name || !body.host || !Number.isInteger(port) || port < 1 || port > 65535)
        return c.json({ error: 'name + host + port (1-65535) required' }, 400);
      const hexErr = validatePayloadHex(body.payloadHex);
      if (hexErr) return c.json({ error: hexErr }, 400);
      const [m] = await tcpMonitorRepo.update(id, {
        name: body.name,
        host: body.host,
        port,
        payloadHex: body.payloadHex ?? null,
        expectBanner: body.expectBanner ?? null,
        intervalSeconds: body.intervalSeconds ?? 60,
      });
      if (!m) return c.json({ error: 'not found' }, 404);
      return c.json(m);
    }
    if (type === 'udp') {
      const port = Number(body.port);
      if (!body.name || !body.host || !Number.isInteger(port) || port < 1 || port > 65535)
        return c.json({ error: 'name + host + port (1-65535) required' }, 400);
      const hexErr = validatePayloadHex(body.payloadHex);
      if (hexErr) return c.json({ error: hexErr }, 400);
      const [m] = await udpMonitorRepo.update(id, {
        name: body.name,
        host: body.host,
        port,
        payloadHex: body.payloadHex ?? null,
        expectResponse: body.expectResponse === true,
        intervalSeconds: body.intervalSeconds ?? 60,
      });
      if (!m) return c.json({ error: 'not found' }, 404);
      return c.json(m);
    }
    if (type === 'db') {
      const port = Number(body.port);
      const protocol = body.protocol;
      if (!body.name || !body.host || !Number.isInteger(port) || port < 1 || port > 65535)
        return c.json({ error: 'name + host + port required' }, 400);
      if (protocol !== 'postgres' && protocol !== 'mysql' && protocol !== 'redis')
        return c.json({ error: 'protocol must be postgres, mysql, or redis' }, 400);
      const [m] = await dbMonitorRepo.update(id, {
        name: body.name,
        host: body.host,
        port,
        protocol,
        tls: body.tls === true,
        intervalSeconds: body.intervalSeconds ?? 60,
      });
      if (!m) return c.json({ error: 'not found' }, 404);
      return c.json(m);
    }
    if (type === 'tls') {
      const port = body.port == null ? 443 : Number(body.port);
      if (!body.name || !body.host || !Number.isInteger(port) || port < 1 || port > 65535)
        return c.json({ error: 'name + host required' }, 400);
      const warnDays = body.warnDays == null ? 30 : Number(body.warnDays);
      if (!Number.isInteger(warnDays) || warnDays < 0)
        return c.json({ error: 'warnDays must be a non-negative integer' }, 400);
      let expectCnRegex: string | null = null;
      if (body.expectCnRegex != null && String(body.expectCnRegex).length > 0) {
        const raw = String(body.expectCnRegex);
        if (raw.length > 200)
          return c.json({ error: 'expectCnRegex too long (max 200 chars)' }, 400);
        if (/\([^()]*[+*][^()]*\)[+*]/.test(raw))
          return c.json({ error: 'expectCnRegex has a trivially-nested quantifier' }, 400);
        try {
          new RegExp(raw);
        } catch (e) {
          return c.json(
            { error: `expectCnRegex invalid: ${e instanceof Error ? e.message : e}` },
            400,
          );
        }
        expectCnRegex = raw;
      }
      const [m] = await tlsMonitorRepo.update(id, {
        name: body.name,
        host: body.host,
        port,
        servername: body.servername || null,
        warnDays,
        intervalSeconds: body.intervalSeconds ?? 60,
        verifyChain: body.verifyChain === true,
        verifyHostname: body.verifyHostname === true,
        expectCnRegex,
      });
      if (!m) return c.json({ error: 'not found' }, 404);
      return c.json(m);
    }
    if (type === 'qa') {
      if (!body.name || !body.targetUrl) return c.json({ error: 'name + targetUrl required' }, 400);
      const [m] = await qaProjectRepo.update(id, {
        name: body.name,
        targetUrl: body.targetUrl,
        intervalSeconds: body.intervalSeconds ?? 300,
      });
      if (!m) return c.json({ error: 'not found' }, 404);
      if (typeof body.script === 'string') {
        await qaProjectRepo.updateFirstTestScript(id, body.script);
      }
      return c.json(m);
    }
    return c.json({ error: 'bad type' }, 400);
  });

  // ---------- API: enable/disable ----------
  app.patch('/api/monitors/:type/:id', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
    const body = await c.req.json();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (bool) required' }, 400);
    if (type === 'url') await urlMonitorRepo.updateEnabled(id, body.enabled);
    else if (type === 'api') await apiCheckRepo.updateEnabled(id, body.enabled);
    else if (type === 'qa') await qaProjectRepo.updateEnabled(id, body.enabled);
    else if (type === 'tcp') await tcpMonitorRepo.updateEnabled(id, body.enabled);
    else if (type === 'udp') await udpMonitorRepo.updateEnabled(id, body.enabled);
    else if (type === 'db') await dbMonitorRepo.updateEnabled(id, body.enabled);
    else if (type === 'tls') await tlsMonitorRepo.updateEnabled(id, body.enabled);
    else if (type === 'heartbeat') await heartbeatRepo.update(id, { enabled: body.enabled });
    else return c.json({ error: 'bad type' }, 400);
    return c.body(null, 204);
  });

  // ---------- API: run now ----------
  app.post('/api/monitors/:type/:id/run', async (c) => {
    const type = c.req.param('type');
    const id = Number(c.req.param('id'));
    if (!Number.isFinite(id)) return c.json({ error: 'bad id' }, 400);
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
        monitor: {
          id: m.id,
          host: m.host,
          port: m.port,
          payloadHex: m.payloadHex,
          expectBanner: m.expectBanner,
          timeoutMs: m.timeoutMs,
        },
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
    if (type === 'db') {
      const [m] = await dbMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const [exec] = await dbMonitorRepo.createExecution(id, 'PENDING');
      await dbQ.add('check', {
        executionId: exec.id,
        monitor: {
          id: m.id,
          protocol: m.protocol,
          tls: m.tls,
          host: m.host,
          port: m.port,
          timeoutMs: m.timeoutMs,
        },
      });
      return c.json({ executionId: exec.id });
    }
    if (type === 'tls') {
      const [m] = await tlsMonitorRepo.findById(id);
      if (!m) return c.json({ error: 'not found' }, 404);
      const [exec] = await tlsMonitorRepo.createExecution(id, 'PENDING');
      await tlsQ.add('check', {
        executionId: exec.id,
        monitor: {
          id: m.id,
          host: m.host,
          port: m.port,
          servername: m.servername,
          warnDays: m.warnDays,
          timeoutMs: m.timeoutMs,
        },
      });
      return c.json({ executionId: exec.id });
    }
    return c.json({ error: 'bad type' }, 400);
  });
}
