/**
 * /api/monitors/* HTTP contract — the aggregated list, availability
 * clamping, per-type detail projections, create/update validation per
 * monitor type (ports, db protocols, TLS expectCnRegex ReDoS gate,
 * heartbeat period/grace), binding replacement, delete cleanup of the
 * FK-less binding tables, enable/disable dispatch and run-now enqueueing.
 * All repos, queues and exec-events are mocked at their module
 * boundaries; the route logic runs through a real Hono app.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import { DEFAULTS } from '../constants.ts';
import {
  execEventsMock,
  mockAlertChannelRepo,
  mockExecEvents,
  mockQaProjectRepo,
  mockRegionRepo,
  mockStatusPageRepo,
  monitorAlertChannelRepoMock,
  monitorRegionRepoMock,
  qaProjectRepoMock,
  statusPageMonitorRepoMock,
} from '../test-support/shared-mocks.ts';

type AnyRow = Record<string, unknown>;

function makeMonitorRepo() {
  return {
    findAllWithLatest: mock(async (): Promise<AnyRow[]> => []),
    findById: mock(async (_id: number): Promise<AnyRow[]> => []),
    findExecutionsByMonitorId: mock(async (_id: number): Promise<AnyRow[]> => []),
    create: mock(async (v: AnyRow): Promise<AnyRow[]> => [{ id: 9, ...v }]),
    createExecution: mock(async (_id: number, _s: string): Promise<AnyRow[]> => [{ id: 77 }]),
    deleteById: mock(async (_id: number): Promise<void> => {}),
    update: mock(async (_id: number, _v: AnyRow): Promise<AnyRow[]> => []),
    updateEnabled: mock(async (_id: number, _e: boolean): Promise<void> => {}),
  };
}

const urlRepo = {
  ...makeMonitorRepo(),
  findAssertionsByMonitorId: mock(async (_id: number): Promise<AnyRow[]> => []),
  createAssertions: mock(async (_id: number, _a: AnyRow[]): Promise<void> => {}),
  replaceAssertions: mock(async (_id: number, _a: AnyRow[]): Promise<void> => {}),
};
const apiRepo = {
  ...makeMonitorRepo(),
  findAssertionsByCheckId: mock(async (_id: number): Promise<AnyRow[]> => []),
  findExecutionsByCheckId: mock(async (_id: number): Promise<AnyRow[]> => []),
  createAssertions: mock(async (_id: number, _a: AnyRow[]): Promise<void> => {}),
  replaceAssertions: mock(async (_id: number, _a: AnyRow[]): Promise<void> => {}),
};
// Shared with the qa processor spec: bun's mock registry is process-wide, so
// two files registering this module with different instances poison whichever
// one loads second.
const qaRepo = qaProjectRepoMock;
const tcpRepo = makeMonitorRepo();
const udpRepo = makeMonitorRepo();
const dbRepo = makeMonitorRepo();
const tlsRepo = makeMonitorRepo();
const heartbeatRepo = {
  list: mock(async (): Promise<AnyRow[]> => []),
  findById: mock(async (_id: number): Promise<AnyRow[]> => []),
  create: mock(async (v: AnyRow): Promise<AnyRow[]> => [{ id: 9, token: 'hb-token', ...v }]),
  update: mock(async (_id: number, _v: AnyRow): Promise<AnyRow[]> => []),
  delete: mock(async (_id: number): Promise<void> => {}),
};
const monitorRegionRepo = monitorRegionRepoMock;
const monitorAlertChannelRepo = monitorAlertChannelRepoMock;
const statusPageMonitorRepo = statusPageMonitorRepoMock;
const getFleetAvailability = mock(async (_days: number): Promise<AnyRow[]> => []);
const { emitMonitorCreated, emitMonitorDeleted } = execEventsMock;

mock.module('../db/repositories/url-monitor.repo.ts', () => ({ urlMonitorRepo: urlRepo }));
mock.module('../db/repositories/api-check.repo.ts', () => ({ apiCheckRepo: apiRepo }));
mockQaProjectRepo();
mock.module('../db/repositories/tcp-monitor.repo.ts', () => ({ tcpMonitorRepo: tcpRepo }));
mock.module('../db/repositories/udp-monitor.repo.ts', () => ({ udpMonitorRepo: udpRepo }));
mock.module('../db/repositories/db-monitor.repo.ts', () => ({ dbMonitorRepo: dbRepo }));
mock.module('../db/repositories/tls-monitor.repo.ts', () => ({ tlsMonitorRepo: tlsRepo }));
mock.module('../db/repositories/heartbeat.repo.ts', () => ({ heartbeatRepo }));
mockRegionRepo();
mockAlertChannelRepo();
mockStatusPageRepo();
mock.module('../db/repositories/availability.repo.ts', () => ({ getFleetAvailability }));
mockExecEvents();

const { registerMonitorRoutes } = await import('./monitors.ts');

const queues = {
  urlQ: { add: mock(async (): Promise<void> => {}) },
  apiQ: { add: mock(async (): Promise<void> => {}) },
  qaQ: { add: mock(async (): Promise<void> => {}) },
  tcpQ: { add: mock(async (): Promise<void> => {}) },
  udpQ: { add: mock(async (): Promise<void> => {}) },
  dbQ: { add: mock(async (): Promise<void> => {}) },
  tlsQ: { add: mock(async (): Promise<void> => {}) },
};

function makeApp(): Hono {
  const app = new Hono();

  registerMonitorRoutes(app, queues as any);
  return app;
}

const allMocks = [
  ...Object.values(urlRepo),
  ...Object.values(apiRepo),
  ...Object.values(qaRepo),
  ...Object.values(tcpRepo),
  ...Object.values(udpRepo),
  ...Object.values(dbRepo),
  ...Object.values(tlsRepo),
  ...Object.values(heartbeatRepo),
  monitorRegionRepo.set,
  monitorAlertChannelRepo.set,
  monitorAlertChannelRepo.clearForMonitor,
  statusPageMonitorRepo.clearForMonitor,
  getFleetAvailability,
  emitMonitorCreated,
  emitMonitorDeleted,
  ...Object.values(queues).map((q) => q.add),
];

beforeEach(() => {
  for (const m of allMocks) m.mockClear();
});

function req(path: string, method = 'GET', body?: unknown) {
  return makeApp().request(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('GET /api/monitors + /api/availability', () => {
  test('aggregates every monitor type keyed by type', async () => {
    urlRepo.findAllWithLatest.mockResolvedValueOnce([{ id: 1 }]);
    heartbeatRepo.list.mockResolvedValueOnce([{ id: 5 }]);

    const res = await req('/api/monitors');
    const body = await res.json();

    expect(Object.keys(body)).toEqual(['url', 'api', 'qa', 'tcp', 'udp', 'db', 'tls', 'heartbeat']);
    expect(body.url).toEqual([{ id: 1 }]);
    expect(body.heartbeat).toEqual([{ id: 5 }]);
  });

  test('clamps the availability window to 1-90 days, default 30', async () => {
    await req('/api/availability');
    expect(getFleetAvailability).toHaveBeenLastCalledWith(30);

    await req('/api/availability?days=500');
    expect(getFleetAvailability).toHaveBeenLastCalledWith(90);

    await req('/api/availability?days=0');
    expect(getFleetAvailability).toHaveBeenLastCalledWith(1);
  });
});

describe('GET /api/monitors/:type/:id', () => {
  test('projects a url monitor with assertions and runs', async () => {
    urlRepo.findById.mockResolvedValueOnce([{ id: 3, name: 'home' }]);
    urlRepo.findAssertionsByMonitorId.mockResolvedValueOnce([{ operator: 'equals' }]);
    urlRepo.findExecutionsByMonitorId.mockResolvedValueOnce([{ id: 100 }]);

    const res = await req('/api/monitors/url/3');
    expect(await res.json()).toEqual({
      monitor: { id: 3, name: 'home', type: 'url' },
      assertions: [{ operator: 'equals' }],
      runs: [{ id: 100 }],
    });
  });

  test('maps latencyMs onto responseTimeMs for socket monitors', async () => {
    tcpRepo.findById.mockResolvedValueOnce([{ id: 4 }]);
    tcpRepo.findExecutionsByMonitorId.mockResolvedValueOnce([{ id: 1, latencyMs: 12 }]);

    const res = await req('/api/monitors/tcp/4');
    const body = await res.json();
    expect(body.runs[0]).toEqual({ id: 1, latencyMs: 12, responseTimeMs: 12 });
  });

  test('heartbeats have no runs', async () => {
    heartbeatRepo.findById.mockResolvedValueOnce([{ id: 6 }]);
    const res = await req('/api/monitors/heartbeat/6');
    expect(await res.json()).toEqual({ monitor: { id: 6, type: 'heartbeat' }, runs: [] });
  });

  test('404 for missing, 400 for bad type or id', async () => {
    expect((await req('/api/monitors/url/9')).status).toBe(404);
    expect((await req('/api/monitors/cron/9')).status).toBe(400);
    expect((await req('/api/monitors/url/x')).status).toBe(400);
  });
});

describe('create validation per type', () => {
  test('url: applies defaults and stores assertions', async () => {
    const res = await req('/api/monitors/url', 'POST', {
      name: 'home',
      url: 'https://example.com',
      assertions: [{ operator: 'equals', statusCode: 200 }],
    });

    expect(res.status).toBe(201);
    expect(urlRepo.create).toHaveBeenCalledWith({
      name: 'home',
      url: 'https://example.com',
      timeoutMs: DEFAULTS.URL_TIMEOUT_MS,
      intervalSeconds: 60,
      enabled: true,
    });
    expect(urlRepo.createAssertions).toHaveBeenCalledWith(9, [
      { operator: 'equals', statusCode: 200 },
    ]);
    expect(emitMonitorCreated).toHaveBeenCalledWith('url', 9);
  });

  test('url: requires name + url', async () => {
    expect((await req('/api/monitors/url', 'POST', { name: 'x' })).status).toBe(400);
  });

  test('api: validates assertion types and operators with an index in the error', async () => {
    const badType = await req('/api/monitors/api', 'POST', {
      name: 'x',
      url: 'https://x',
      assertions: [{ type: 'latency', operator: 'equals' }],
    });
    expect(badType.status).toBe(400);
    expect((await badType.json()).error).toContain('assertions[0].type');

    const badOp = await req('/api/monitors/api', 'POST', {
      name: 'x',
      url: 'https://x',
      assertions: [
        { type: 'status_code', operator: 'equals' },
        { type: 'json_path', operator: 'matches' },
      ],
    });
    expect((await badOp.json()).error).toContain('assertions[1].operator');

    const notArray = await req('/api/monitors/api', 'POST', {
      name: 'x',
      url: 'https://x',
      assertions: 'nope',
    });
    expect(await notArray.json()).toEqual({ error: 'assertions must be an array' });
  });

  test('api: nulls optional assertion fields on create', async () => {
    await req('/api/monitors/api', 'POST', {
      name: 'x',
      url: 'https://x',
      assertions: [{ type: 'status_code', operator: 'equals', value: '200' }],
    });
    expect(apiRepo.createAssertions).toHaveBeenCalledWith(9, [
      { type: 'status_code', operator: 'equals', path: null, value: '200' },
    ]);
  });

  test.each([0, 65536, Number.NaN, 1.5])('tcp: rejects port %p', async (port) => {
    const res = await req('/api/monitors/tcp', 'POST', { name: 'x', host: 'h', port });
    expect(res.status).toBe(400);
  });

  test('tcp/udp: reject a malformed payloadHex with the parser message', async () => {
    const res = await req('/api/monitors/tcp', 'POST', {
      name: 'x',
      host: 'h',
      port: 6379,
      payloadHex: 'abc',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('even-length');
  });

  test('udp: defaults expectResponse to false', async () => {
    await req('/api/monitors/udp', 'POST', { name: 'x', host: 'h', port: 53 });
    expect(udpRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ expectResponse: false, timeoutMs: DEFAULTS.UDP_TIMEOUT_MS }),
    );
  });

  test('db: requires a known protocol and coerces tls to a boolean', async () => {
    const bad = await req('/api/monitors/db', 'POST', {
      name: 'x',
      host: 'h',
      port: 5432,
      protocol: 'mongo',
    });
    expect(await bad.json()).toEqual({ error: 'protocol must be postgres, mysql, or redis' });

    await req('/api/monitors/db', 'POST', {
      name: 'x',
      host: 'h',
      port: 5432,
      protocol: 'postgres',
      tls: 'yes',
    });
    expect(dbRepo.create).toHaveBeenCalledWith(expect.objectContaining({ tls: false }));
  });

  test('tls: defaults the port to 443 and validates warnDays', async () => {
    await req('/api/monitors/tls', 'POST', { name: 'x', host: 'h' });
    expect(tlsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ port: 443, warnDays: 30 }),
    );

    const bad = await req('/api/monitors/tls', 'POST', { name: 'x', host: 'h', warnDays: -1 });
    expect((await bad.json()).error).toContain('warnDays');
  });

  test('tls: gates expectCnRegex against length, nested quantifiers and syntax', async () => {
    const tooLong = await req('/api/monitors/tls', 'POST', {
      name: 'x',
      host: 'h',
      expectCnRegex: 'a'.repeat(201),
    });
    expect((await tooLong.json()).error).toContain('too long');

    const nested = await req('/api/monitors/tls', 'POST', {
      name: 'x',
      host: 'h',
      expectCnRegex: '(a+)+$',
    });
    expect((await nested.json()).error).toContain('nested quantifier');

    const invalid = await req('/api/monitors/tls', 'POST', {
      name: 'x',
      host: 'h',
      expectCnRegex: '([',
    });
    expect((await invalid.json()).error).toContain('not a valid regex');

    await req('/api/monitors/tls', 'POST', {
      name: 'x',
      host: 'h',
      expectCnRegex: String.raw`^\*\.example\.com$`,
    });
    expect(tlsRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ expectCnRegex: String.raw`^\*\.example\.com$` }),
    );
  });

  test('heartbeat: enforces period >= 30 and grace >= 0 (default 60)', async () => {
    expect((await req('/api/monitors/heartbeat', 'POST', { name: 'x' })).status).toBe(400);
    expect(
      (await req('/api/monitors/heartbeat', 'POST', { name: 'x', periodSeconds: 29 })).status,
    ).toBe(400);
    expect(
      (
        await req('/api/monitors/heartbeat', 'POST', {
          name: 'x',
          periodSeconds: 60,
          graceSeconds: -1,
        })
      ).status,
    ).toBe(400);

    const res = await req('/api/monitors/heartbeat', 'POST', { name: 'x', periodSeconds: 60 });
    expect(res.status).toBe(201);
    expect(heartbeatRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ periodSeconds: 60, graceSeconds: 60 }),
    );
  });

  test('qa: requires a non-empty tests array and maps tests on create', async () => {
    const bad = await req('/api/monitors/qa', 'POST', {
      name: 'x',
      targetUrl: 'https://x',
      tests: [],
    });
    expect(bad.status).toBe(400);

    await req('/api/monitors/qa', 'POST', {
      name: 'x',
      targetUrl: 'https://x',
      tests: [{ name: 'login works', script: 'await page.goto(...)' }],
    });
    expect(qaRepo.createTests).toHaveBeenCalledWith(9, [
      {
        testName: 'login works',
        testType: 'browser',
        script: 'await page.goto(...)',
        description: null,
      },
    ]);
  });
});

describe('bindings, delete, enable/disable', () => {
  test('replaces region bindings after validating integer ids', async () => {
    const bad = await req('/api/monitors/url/3/regions', 'PUT', { regionIds: [1, 'x'] });
    expect(bad.status).toBe(400);

    const res = await req('/api/monitors/url/3/regions', 'PUT', { regionIds: [1, 2] });
    expect(await res.json()).toEqual({ ok: true, regionIds: [1, 2] });
    expect(monitorRegionRepo.set).toHaveBeenCalledWith('url', 3, [1, 2]);
  });

  test('replaces channel bindings and rejects unknown types', async () => {
    expect((await req('/api/monitors/cron/3/channels', 'PUT', { channelIds: [] })).status).toBe(
      400,
    );

    await req('/api/monitors/tls/3/channels', 'PUT', { channelIds: [4] });
    expect(monitorAlertChannelRepo.set).toHaveBeenCalledWith('tls', 3, [4]);
  });

  test('delete dispatches per type and cleans the FK-less binding tables', async () => {
    const res = await req('/api/monitors/url/3', 'DELETE');
    expect(res.status).toBe(204);
    expect(urlRepo.deleteById).toHaveBeenCalledWith(3);
    expect(monitorAlertChannelRepo.clearForMonitor).toHaveBeenCalledWith('url', 3);
    expect(statusPageMonitorRepo.clearForMonitor).toHaveBeenCalledWith('url', 3);
    expect(emitMonitorDeleted).toHaveBeenCalledWith('url', 3);

    await req('/api/monitors/heartbeat/6', 'DELETE');
    expect(heartbeatRepo.delete).toHaveBeenCalledWith(6);

    expect((await req('/api/monitors/cron/3', 'DELETE')).status).toBe(400);
  });

  test('enable/disable requires a boolean and dispatches per type', async () => {
    expect((await req('/api/monitors/url/3', 'PATCH', { enabled: 'yes' })).status).toBe(400);

    expect((await req('/api/monitors/url/3', 'PATCH', { enabled: false })).status).toBe(204);
    expect(urlRepo.updateEnabled).toHaveBeenCalledWith(3, false);

    await req('/api/monitors/heartbeat/6', 'PATCH', { enabled: true });
    expect(heartbeatRepo.update).toHaveBeenCalledWith(6, { enabled: true });
  });
});

describe('full update', () => {
  test('url: updates and replaces assertions, 404 when missing', async () => {
    tlsRepo.update.mockClear();
    urlRepo.update.mockResolvedValueOnce([{ id: 3, name: 'new' }]);

    const res = await req('/api/monitors/url/3', 'PUT', {
      name: 'new',
      url: 'https://new.example.com',
      assertions: [{ operator: 'equals', statusCode: '204' }],
    });
    expect(await res.json()).toEqual({ id: 3, name: 'new' });
    expect(urlRepo.replaceAssertions).toHaveBeenCalledWith(3, [
      { operator: 'equals', statusCode: 204 },
    ]);

    const missing = await req('/api/monitors/url/9', 'PUT', { name: 'x', url: 'https://x' });
    expect(missing.status).toBe(404);
  });

  test('heartbeat PUT alias validates like the PATCH', async () => {
    expect((await req('/api/monitors/heartbeat/6', 'PUT', { periodSeconds: 5 })).status).toBe(400);

    heartbeatRepo.update.mockResolvedValueOnce([{ id: 6, periodSeconds: 120 }]);
    const res = await req('/api/monitors/heartbeat/6', 'PUT', { periodSeconds: 120 });
    expect(await res.json()).toEqual({ id: 6, periodSeconds: 120 });
  });

  test('qa: updates the first test script when provided', async () => {
    qaRepo.update.mockResolvedValueOnce([{ id: 8 }]);
    await req('/api/monitors/qa/8', 'PUT', {
      name: 'suite',
      targetUrl: 'https://x',
      script: 'new script',
    });
    expect(qaRepo.updateFirstTestScript).toHaveBeenCalledWith(8, 'new script');
  });

  test('rejects unknown types', async () => {
    expect((await req('/api/monitors/cron/3', 'PUT', { name: 'x' })).status).toBe(400);
  });
});

describe('run now', () => {
  test('url: creates a PENDING execution and enqueues the check payload', async () => {
    urlRepo.findById.mockResolvedValueOnce([
      { id: 3, url: 'https://example.com', timeoutMs: 5000 },
    ]);
    urlRepo.findAssertionsByMonitorId.mockResolvedValueOnce([{ operator: 'equals' }]);

    const res = await req('/api/monitors/url/3/run', 'POST');
    expect(await res.json()).toEqual({ executionId: 77 });
    expect(urlRepo.createExecution).toHaveBeenCalledWith(3, 'PENDING');
    expect(queues.urlQ.add).toHaveBeenCalledWith('check', {
      executionId: 77,
      monitor: { id: 3, url: 'https://example.com', timeoutMs: 5000 },
      assertions: [{ operator: 'equals' }],
    });
  });

  test('qa: refuses a project without tests, enqueues a full run otherwise', async () => {
    qaRepo.findById.mockResolvedValueOnce([{ id: 8, targetUrl: 'https://x' }]);
    qaRepo.findTestsByProjectId.mockResolvedValueOnce([]);
    const empty = await req('/api/monitors/qa/8/run', 'POST');
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: 'no tests on this project' });

    qaRepo.findById.mockResolvedValueOnce([
      { id: 8, targetUrl: 'https://x', credentials: null, config: {} },
    ]);
    qaRepo.findTestsByProjectId.mockResolvedValueOnce([{ testName: 't1', script: 's' }]);
    const res = await req('/api/monitors/qa/8/run', 'POST');
    expect(await res.json()).toEqual({ ok: true });

    const payload = (queues.qaQ.add.mock.calls[0] as unknown as [string, AnyRow])[1];
    expect(payload).toMatchObject({ type: 'qa-project-run', projectId: 8 });
    expect(qaRepo.findTestsByProjectId).toHaveBeenLastCalledWith(8, { includeScript: true });
  });

  test('tls: enqueues the certificate probe payload', async () => {
    tlsRepo.findById.mockResolvedValueOnce([
      { id: 5, host: 'example.com', port: 443, servername: null, warnDays: 30, timeoutMs: 5000 },
    ]);

    await req('/api/monitors/tls/5/run', 'POST');
    expect(queues.tlsQ.add).toHaveBeenCalledWith('check', {
      executionId: 77,
      monitor: {
        id: 5,
        host: 'example.com',
        port: 443,
        servername: null,
        warnDays: 30,
        timeoutMs: 5000,
      },
    });
  });

  test('404 for a missing monitor, 400 for unknown types', async () => {
    expect((await req('/api/monitors/tcp/9/run', 'POST')).status).toBe(404);
    expect((await req('/api/monitors/cron/9/run', 'POST')).status).toBe(400);
  });
});

describe('full update — socket, db and tls types', () => {
  test('api: re-validates assertions, applies method/interval defaults and replaces them', async () => {
    apiRepo.update.mockResolvedValueOnce([{ id: 4, name: 'checkout' }]);

    const res = await req('/api/monitors/api/4', 'PUT', {
      name: 'checkout',
      url: 'https://x.test/health',
      assertions: [{ type: 'status_code', operator: 'equals', value: '200' }],
    });

    expect(res.status).toBe(200);
    expect(apiRepo.update).toHaveBeenLastCalledWith(4, {
      name: 'checkout',
      url: 'https://x.test/health',
      method: 'GET',
      intervalSeconds: 60,
    });
    // Optional assertion fields are nulled, not left undefined.
    expect(apiRepo.replaceAssertions).toHaveBeenLastCalledWith(4, [
      { type: 'status_code', operator: 'equals', path: null, value: '200' },
    ]);
  });

  test('api: rejects a bad assertion by index before touching the repo', async () => {
    const res = await req('/api/monitors/api/4', 'PUT', {
      name: 'n',
      url: 'u',
      assertions: [
        { type: 'status_code', operator: 'equals' },
        { type: 'nope', operator: 'equals' },
      ],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'assertions[1].type invalid' });
    expect(apiRepo.update).not.toHaveBeenCalled();
    expect(apiRepo.replaceAssertions).not.toHaveBeenCalled();
  });

  test('api: clears assertions when the body omits them', async () => {
    apiRepo.update.mockResolvedValueOnce([{ id: 4 }]);

    await req('/api/monitors/api/4', 'PUT', { name: 'n', url: 'u' });

    expect(apiRepo.replaceAssertions).toHaveBeenLastCalledWith(4, []);
  });

  test('api: 400 without name + url, 404 when the row is gone', async () => {
    expect((await req('/api/monitors/api/4', 'PUT', { name: 'n' })).status).toBe(400);
    // update mock defaults to [] -> not found
    expect((await req('/api/monitors/api/4', 'PUT', { name: 'n', url: 'u' })).status).toBe(404);
  });

  test('tcp: persists the probe fields and defaults the optional ones to null', async () => {
    tcpRepo.update.mockResolvedValueOnce([{ id: 2 }]);

    const res = await req('/api/monitors/tcp/2', 'PUT', {
      name: 'smtp',
      host: 'mail.test',
      port: 25,
    });

    expect(res.status).toBe(200);
    expect(tcpRepo.update).toHaveBeenLastCalledWith(2, {
      name: 'smtp',
      host: 'mail.test',
      port: 25,
      payloadHex: null,
      expectBanner: null,
      intervalSeconds: 60,
    });
  });

  test('tcp: rejects an out-of-range port and a malformed payloadHex', async () => {
    const bad = await req('/api/monitors/tcp/2', 'PUT', { name: 'n', host: 'h', port: 70000 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'name + host + port (1-65535) required' });

    const hex = await req('/api/monitors/tcp/2', 'PUT', {
      name: 'n',
      host: 'h',
      port: 25,
      payloadHex: 'zz',
    });
    expect(hex.status).toBe(400);
    expect(tcpRepo.update).not.toHaveBeenCalled();
  });

  test('udp: coerces expectResponse to a strict boolean', async () => {
    udpRepo.update.mockResolvedValueOnce([{ id: 3 }]);

    await req('/api/monitors/udp/3', 'PUT', {
      name: 'dns',
      host: 'ns.test',
      port: 53,
      expectResponse: 'yes',
    });

    // Only a literal `true` enables it — a truthy string must not.
    expect(udpRepo.update).toHaveBeenLastCalledWith(3, {
      name: 'dns',
      host: 'ns.test',
      port: 53,
      payloadHex: null,
      expectResponse: false,
      intervalSeconds: 60,
    });
  });

  test('db: requires a known protocol and coerces tls', async () => {
    const bad = await req('/api/monitors/db/5', 'PUT', {
      name: 'pg',
      host: 'h',
      port: 5432,
      protocol: 'mongo',
    });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'protocol must be postgres, mysql, or redis' });

    dbRepo.update.mockResolvedValueOnce([{ id: 5 }]);
    await req('/api/monitors/db/5', 'PUT', {
      name: 'pg',
      host: 'h',
      port: 5432,
      protocol: 'postgres',
      tls: 1,
    });
    expect(dbRepo.update).toHaveBeenLastCalledWith(5, {
      name: 'pg',
      host: 'h',
      port: 5432,
      protocol: 'postgres',
      tls: false,
      intervalSeconds: 60,
    });
  });

  test('tls: defaults port 443 / warnDays 30 and nulls a blank servername', async () => {
    tlsRepo.update.mockResolvedValueOnce([{ id: 6 }]);

    await req('/api/monitors/tls/6', 'PUT', { name: 'cert', host: 'x.test', servername: '' });

    expect(tlsRepo.update).toHaveBeenLastCalledWith(6, {
      name: 'cert',
      host: 'x.test',
      port: 443,
      servername: null,
      warnDays: 30,
      intervalSeconds: 60,
      verifyChain: false,
      verifyHostname: false,
      expectCnRegex: null,
    });
  });

  test('tls: applies the same expectCnRegex ReDoS gate as create', async () => {
    const long = await req('/api/monitors/tls/6', 'PUT', {
      name: 'c',
      host: 'h',
      expectCnRegex: 'a'.repeat(201),
    });
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: 'expectCnRegex too long (max 200 chars)' });

    const nested = await req('/api/monitors/tls/6', 'PUT', {
      name: 'c',
      host: 'h',
      expectCnRegex: '(a+)+',
    });
    expect(nested.status).toBe(400);
    expect(await nested.json()).toEqual({
      error: 'expectCnRegex has a trivially-nested quantifier',
    });

    const syntax = await req('/api/monitors/tls/6', 'PUT', {
      name: 'c',
      host: 'h',
      expectCnRegex: '(unclosed',
    });
    expect(syntax.status).toBe(400);
    expect((await syntax.json()).error).toMatch(/^expectCnRegex invalid: /);

    expect(tlsRepo.update).not.toHaveBeenCalled();
  });

  test('tls: rejects a negative warnDays but keeps a valid regex', async () => {
    const warn = await req('/api/monitors/tls/6', 'PUT', { name: 'c', host: 'h', warnDays: -1 });
    expect(warn.status).toBe(400);
    expect(await warn.json()).toEqual({ error: 'warnDays must be a non-negative integer' });

    tlsRepo.update.mockResolvedValueOnce([{ id: 6 }]);
    await req('/api/monitors/tls/6', 'PUT', {
      name: 'c',
      host: 'h',
      expectCnRegex: String.raw`^x\.test$`,
      verifyChain: true,
    });
    const [, patch] = tlsRepo.update.mock.calls.at(-1) as [number, Record<string, unknown>];
    expect(patch.expectCnRegex).toBe(String.raw`^x\.test$`);
    expect(patch.verifyChain).toBe(true);
  });

  test('404 when the socket/db/tls row is missing', async () => {
    // every update mock defaults to [] -> not found
    for (const path of ['tcp/2', 'udp/3', 'db/5', 'tls/6']) {
      const body =
        path === 'db/5'
          ? { name: 'n', host: 'h', port: 1, protocol: 'redis' }
          : { name: 'n', host: 'h', port: 1 };
      expect((await req(`/api/monitors/${path}`, 'PUT', body)).status).toBe(404);
    }
  });

  test('bad id is rejected before the body is read', async () => {
    expect((await req('/api/monitors/url/abc', 'PUT', { name: 'n', url: 'u' })).status).toBe(400);
  });
});

describe('enable/disable — full type dispatch', () => {
  test.each([
    ['api', () => apiRepo.updateEnabled],
    ['qa', () => qaRepo.updateEnabled],
    ['tcp', () => tcpRepo.updateEnabled],
    ['udp', () => udpRepo.updateEnabled],
    ['db', () => dbRepo.updateEnabled],
    ['tls', () => tlsRepo.updateEnabled],
  ])('%s routes to its own repo and answers 204', async (type, pick) => {
    const res = await req(`/api/monitors/${type}/8`, 'PATCH', { enabled: false });

    expect(res.status).toBe(204);
    expect(pick()).toHaveBeenLastCalledWith(8, false);
  });

  // The generic handler has an `else if (type === 'heartbeat')` arm, but it is
  // unreachable: the dedicated `app.patch('/api/monitors/heartbeat/:id')` is
  // registered earlier and Hono takes the first match, so a heartbeat PATCH
  // always lands there and answers with the row (or 404), never 204.
  test('heartbeat PATCH is served by the dedicated handler, not the generic one', async () => {
    heartbeatRepo.update.mockResolvedValueOnce([{ id: 8, enabled: true }]);

    const res = await req('/api/monitors/heartbeat/8', 'PATCH', { enabled: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 8, enabled: true });
    expect(heartbeatRepo.update).toHaveBeenLastCalledWith(8, { enabled: true });
  });

  test('unknown type is a 400 and toggles nothing', async () => {
    const res = await req('/api/monitors/cron/8', 'PATCH', { enabled: true });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad type' });
    expect(urlRepo.updateEnabled).not.toHaveBeenCalled();
  });
});

describe('run now — api, socket and db types', () => {
  test('api: enqueues the check with its assertions and returns the execution id', async () => {
    apiRepo.findById.mockResolvedValueOnce([{ id: 4, url: 'https://x.test' }]);
    apiRepo.findAssertionsByCheckId.mockResolvedValueOnce([{ type: 'status' }]);
    apiRepo.createExecution.mockResolvedValueOnce([{ id: 55 }]);

    const res = await req('/api/monitors/api/4/run', 'POST');

    expect(await res.json()).toEqual({ executionId: 55 });
    expect(apiRepo.createExecution).toHaveBeenLastCalledWith(4, 'PENDING');
    expect(queues.apiQ.add).toHaveBeenLastCalledWith('check', {
      executionId: 55,
      apiCheck: { id: 4, url: 'https://x.test' },
      assertions: [{ type: 'status' }],
    });
  });

  test('tcp: enqueues the banner-probe payload', async () => {
    tcpRepo.findById.mockResolvedValueOnce([
      {
        id: 2,
        host: 'mail.test',
        port: 25,
        payloadHex: 'ff',
        expectBanner: '220',
        timeoutMs: 5000,
      },
    ]);
    tcpRepo.createExecution.mockResolvedValueOnce([{ id: 56 }]);

    const res = await req('/api/monitors/tcp/2/run', 'POST');

    expect(await res.json()).toEqual({ executionId: 56 });
    expect(queues.tcpQ.add).toHaveBeenLastCalledWith('check', {
      executionId: 56,
      monitor: {
        id: 2,
        host: 'mail.test',
        port: 25,
        payloadHex: 'ff',
        expectBanner: '220',
        timeoutMs: 5000,
      },
    });
  });

  test('udp: carries expectResponse onto the queue payload', async () => {
    udpRepo.findById.mockResolvedValueOnce([
      { id: 3, host: 'ns.test', port: 53, payloadHex: 'ab', expectResponse: true, timeoutMs: 2000 },
    ]);
    udpRepo.createExecution.mockResolvedValueOnce([{ id: 57 }]);

    await req('/api/monitors/udp/3/run', 'POST');

    expect(queues.udpQ.add).toHaveBeenLastCalledWith('check', {
      executionId: 57,
      monitor: {
        id: 3,
        host: 'ns.test',
        port: 53,
        payloadHex: 'ab',
        expectResponse: true,
        timeoutMs: 2000,
      },
    });
  });

  test('db: carries protocol and tls onto the queue payload', async () => {
    dbRepo.findById.mockResolvedValueOnce([
      { id: 5, protocol: 'postgres', tls: true, host: 'pg.test', port: 5432, timeoutMs: 3000 },
    ]);
    dbRepo.createExecution.mockResolvedValueOnce([{ id: 58 }]);

    await req('/api/monitors/db/5/run', 'POST');

    expect(queues.dbQ.add).toHaveBeenLastCalledWith('check', {
      executionId: 58,
      monitor: {
        id: 5,
        protocol: 'postgres',
        tls: true,
        host: 'pg.test',
        port: 5432,
        timeoutMs: 3000,
      },
    });
  });

  test.each(['api', 'udp', 'db'])('%s: 404 leaves the queue untouched', async (type) => {
    const res = await req(`/api/monitors/${type}/9/run`, 'POST');

    expect(res.status).toBe(404);
    for (const q of Object.values(queues)) expect(q.add).not.toHaveBeenCalled();
  });
});

describe('GET /api/monitors/:type/:id — detail payloads', () => {
  test('api: returns the check with its assertions and executions', async () => {
    apiRepo.findById.mockResolvedValueOnce([{ id: 4, name: 'checkout' }]);
    apiRepo.findAssertionsByCheckId.mockResolvedValueOnce([{ id: 1, kind: 'status' }]);
    apiRepo.findExecutionsByCheckId.mockResolvedValueOnce([{ id: 70, status: 'SUCCESS' }]);

    const body = await (await req('/api/monitors/api/4')).json();

    expect(body).toEqual({
      monitor: { id: 4, name: 'checkout', type: 'api' },
      assertions: [{ id: 1, kind: 'status' }],
      runs: [{ id: 70, status: 'SUCCESS' }],
    });
  });

  test('qa: returns tests rather than assertions', async () => {
    qaRepo.findById.mockResolvedValueOnce([{ id: 6, name: 'signup flow' }]);
    qaRepo.findTestsByProjectId.mockResolvedValueOnce([{ id: 11, name: 'login' }]);
    qaRepo.findExecutionsByProjectId.mockResolvedValueOnce([{ id: 90 }]);

    const body = await (await req('/api/monitors/qa/6')).json();

    expect(body).toEqual({
      monitor: { id: 6, name: 'signup flow', type: 'qa' },
      tests: [{ id: 11, name: 'login' }],
      runs: [{ id: 90 }],
    });
  });

  // The socket/db/tls detail arms rename the stored latencyMs to the
  // responseTimeMs the UI charts read. Renaming it back in the repo would
  // silently flatten every latency graph, so pin the mapping per type.
  const latencyTypes: [string, ReturnType<typeof makeMonitorRepo>][] = [
    ['tcp', tcpRepo],
    ['udp', udpRepo],
    ['db', dbRepo],
    ['tls', tlsRepo],
  ];

  test.each(latencyTypes)(
    '%s: exposes latencyMs as responseTimeMs on every run',
    async (type, repo) => {
      repo.findById.mockResolvedValueOnce([{ id: 3, name: `${type}-probe` }]);
      repo.findExecutionsByMonitorId.mockResolvedValueOnce([
        { id: 21, latencyMs: 42, status: 'SUCCESS' },
        { id: 22, latencyMs: null, status: 'FAILED' },
      ]);

      const body = await (await req(`/api/monitors/${type}/3`)).json();

      expect(body.monitor).toEqual({ id: 3, name: `${type}-probe`, type });
      expect(body.runs).toEqual([
        { id: 21, latencyMs: 42, status: 'SUCCESS', responseTimeMs: 42 },
        { id: 22, latencyMs: null, status: 'FAILED', responseTimeMs: null },
      ]);
    },
  );

  // qaRepo is the process-wide shared mock, so a `...Once` queued by another
  // spec can still be pending here: prime the empty row explicitly rather
  // than relying on the default left behind.
  const detailRepos: [string, { findById: ReturnType<typeof mock> }][] = [
    ['api', apiRepo],
    ['qa', qaRepo],
    ['tcp', tcpRepo],
    ['udp', udpRepo],
    ['db', dbRepo],
    ['tls', tlsRepo],
    ['heartbeat', heartbeatRepo],
  ];

  test.each(detailRepos)('%s: 404 when the row is gone', async (type, repo) => {
    repo.findById.mockResolvedValueOnce([]);

    expect((await req(`/api/monitors/${type}/9`)).status).toBe(404);
  });
});
