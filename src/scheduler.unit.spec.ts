/**
 * Scheduler contract — drain, dual-path dispatch (BullMQ master vs regional
 * Redis list), per-monitor-type ticking, abandoned QA run sweep, heartbeat
 * overdue handling, and region online/offline transitions.
 *
 * All external I/O is mocked: BullMQ queues, Redis, every monitor repo, the
 * alert dispatcher, event bus, and QA run closeout.
 */

import { beforeEach, describe, expect, mock, test, afterEach } from 'bun:test';
import { makeNonce, jobIdSuffix, buildJobId } from './scheduler-jobid.ts';
import {
  mockQaProjectRepo,
  mockRegionRepo,
  qaProjectRepoMock,
  regionRepoMock,
  monitorRegionRepoMock,
} from './test-support/shared-mocks.ts';

// Fast scheduler tick for tests that exercise the interval callback.
process.env.SCHEDULER_TICK_MS = '100';
process.env.QA_RUN_ABANDONED_MS = '60000';

type Row = Record<string, unknown>;
type QueueCall = { queue: string; name: string; data: Row; opts: Row };
type LpushCall = { key: string; payload: Row };

// ---- BullMQ Queue ----
const queueInstances: Array<{
  name: string;
  add: ReturnType<typeof mock>;
  drain: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
}> = [];
let queueAddCalls: QueueCall[] = [];
let queueDrainCalls: string[] = [];
let queueCloseCalls: string[] = [];
let drainFailures: Set<string> = new Set();

function makeQueueInstance(name: string) {
  const q = {
    name,
    add: mock(async (jobName: string, data: Row, opts: Row) => {
      queueAddCalls.push({ queue: name, name: jobName, data, opts });
    }),
    drain: mock(async () => {
      queueDrainCalls.push(name);
      if (drainFailures.has(name)) {
        drainFailures.delete(name);
        throw new Error('redis blip');
      }
    }),
    close: mock(async () => {
      queueCloseCalls.push(name);
    }),
  };
  queueInstances.push(q);
  return q;
}

mock.module('bullmq', () => ({
  Queue: mock((name: string, _opts: unknown) => makeQueueInstance(name)),
}));

// ---- Redis connection (regional LPUSH path) ----
let lpushCalls: LpushCall[] = [];
const redis = {
  lpush: mock(async (key: string, payload: string) => {
    lpushCalls.push({ key, payload: JSON.parse(payload) as Row });
    return 1;
  }),
};

// ---- Monitor repos ----
function makeMonitorRepo() {
  return {
    findDue: mock(async (): Promise<Row[]> => []),
    createExecution: mock(
      async (_id: number, _status: string, _regionId: number | null): Promise<Row[]> => [{ id: 1 }],
    ),
    updateExecution: mock(async (_id: number, _data: Row): Promise<void> => {}),
  };
}

const urlMonitorRepoMock = {
  ...makeMonitorRepo(),
  findAssertionsByMonitorId: mock(async (_id: number): Promise<Row[]> => []),
};

const apiCheckRepoMock = {
  ...makeMonitorRepo(),
  findAssertionsByCheckId: mock(async (_id: number): Promise<Row[]> => []),
};

const tcpMonitorRepoMock = makeMonitorRepo();
const udpMonitorRepoMock = makeMonitorRepo();
const dbMonitorRepoMock = makeMonitorRepo();
const tlsMonitorRepoMock = makeMonitorRepo();

mock.module('./db/repositories/url-monitor.repo.ts', () => ({
  urlMonitorRepo: urlMonitorRepoMock,
}));
mock.module('./db/repositories/api-check.repo.ts', () => ({ apiCheckRepo: apiCheckRepoMock }));
mock.module('./db/repositories/tcp-monitor.repo.ts', () => ({
  tcpMonitorRepo: tcpMonitorRepoMock,
}));
mock.module('./db/repositories/udp-monitor.repo.ts', () => ({
  udpMonitorRepo: udpMonitorRepoMock,
}));
mock.module('./db/repositories/db-monitor.repo.ts', () => ({ dbMonitorRepo: dbMonitorRepoMock }));
mock.module('./db/repositories/tls-monitor.repo.ts', () => ({
  tlsMonitorRepo: tlsMonitorRepoMock,
}));

// ---- Heartbeat repo ----
const heartbeatRepoMock = {
  findOverdue: mock(async (): Promise<Row[]> => []),
  markOverdue: mock(async (_id: number): Promise<Row | null> => null),
};
mock.module('./db/repositories/heartbeat.repo.ts', () => ({ heartbeatRepo: heartbeatRepoMock }));

// ---- Shared repo mocks (extend with scheduler-specific methods) ----
mockRegionRepo();
monitorRegionRepoMock.forMonitor = mock(async (_type: string, _id: number): Promise<Row[]> => []);

mockQaProjectRepo();
qaProjectRepoMock.findDue = mock(async (): Promise<Row[]> => []);
qaProjectRepoMock.findAbandonedRuns = mock(async (_cutoff: Date): Promise<Row[]> => []);
qaProjectRepoMock.markRunTestsAbandoned = mock(
  async (_runId: number, _message: string): Promise<number[]> => [],
);

// ---- Services ----
const dispatchAlertMock = mock(async (_ctx: Row): Promise<void> => {});
const execEventsMock = { emit: mock(() => true) };

const finalizeUnfinishedQaRunMock = mock(
  async (_run: Row, _message: string): Promise<boolean> => false,
);
mock.module('./services/qa-run-closeout.ts', () => ({
  finalizeUnfinishedQaRun: finalizeUnfinishedQaRunMock,
}));

const loggerMock = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}) };
mock.module('./utils/logger.ts', () => ({ logger: loggerMock }));

// ---- Timer capture ----
let intervalCallback: (() => void) | null = null;
let intervalMs: number | null = null;
let clearedHandle: number | null = null;
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

mock.module('ioredis', () => ({
  Redis: mock(() => redis),
  default: mock(() => redis),
}));

// Import the scheduler after all mocks are registered.
const {
  startScheduler,
  tickUrlMonitors,
  tickApiChecks,
  tickTcpMonitors,
  tickUdpMonitors,
  tickDbMonitors,
  tickTlsMonitors,
  tickQaProjects,
  tickHeartbeats,
  tickAbandonedQaRuns,
  tickRegionStatus,
  schedulerDeps,
} = await import('./scheduler.ts');

const originalSchedulerDeps = {
  execEvents: schedulerDeps.execEvents,
  dispatchAlert: schedulerDeps.dispatchAlert,
};

function resetMocks() {
  queueInstances.length = 0;
  queueAddCalls = [];
  queueDrainCalls = [];
  queueCloseCalls = [];
  drainFailures = new Set();
  lpushCalls = [];

  urlMonitorRepoMock.findDue.mockReset();
  urlMonitorRepoMock.createExecution.mockReset();
  urlMonitorRepoMock.updateExecution.mockReset();
  urlMonitorRepoMock.findAssertionsByMonitorId.mockReset();
  urlMonitorRepoMock.findDue.mockResolvedValue([]);
  urlMonitorRepoMock.createExecution.mockResolvedValue([{ id: 1 }]);
  urlMonitorRepoMock.updateExecution.mockResolvedValue(undefined);
  urlMonitorRepoMock.findAssertionsByMonitorId.mockResolvedValue([]);

  apiCheckRepoMock.findDue.mockReset();
  apiCheckRepoMock.createExecution.mockReset();
  apiCheckRepoMock.updateExecution.mockReset();
  apiCheckRepoMock.findAssertionsByCheckId.mockReset();
  apiCheckRepoMock.findDue.mockResolvedValue([]);
  apiCheckRepoMock.createExecution.mockResolvedValue([{ id: 1 }]);
  apiCheckRepoMock.updateExecution.mockResolvedValue(undefined);
  apiCheckRepoMock.findAssertionsByCheckId.mockResolvedValue([]);

  tcpMonitorRepoMock.findDue.mockReset();
  tcpMonitorRepoMock.createExecution.mockReset();
  tcpMonitorRepoMock.updateExecution.mockReset();
  tcpMonitorRepoMock.findDue.mockResolvedValue([]);
  tcpMonitorRepoMock.createExecution.mockResolvedValue([{ id: 1 }]);
  tcpMonitorRepoMock.updateExecution.mockResolvedValue(undefined);

  udpMonitorRepoMock.findDue.mockReset();
  udpMonitorRepoMock.createExecution.mockReset();
  udpMonitorRepoMock.updateExecution.mockReset();
  udpMonitorRepoMock.findDue.mockResolvedValue([]);
  udpMonitorRepoMock.createExecution.mockResolvedValue([{ id: 1 }]);
  udpMonitorRepoMock.updateExecution.mockResolvedValue(undefined);

  dbMonitorRepoMock.findDue.mockReset();
  dbMonitorRepoMock.createExecution.mockReset();
  dbMonitorRepoMock.updateExecution.mockReset();
  dbMonitorRepoMock.findDue.mockResolvedValue([]);
  dbMonitorRepoMock.createExecution.mockResolvedValue([{ id: 1 }]);
  dbMonitorRepoMock.updateExecution.mockResolvedValue(undefined);

  tlsMonitorRepoMock.findDue.mockReset();
  tlsMonitorRepoMock.createExecution.mockReset();
  tlsMonitorRepoMock.updateExecution.mockReset();
  tlsMonitorRepoMock.findDue.mockResolvedValue([]);
  tlsMonitorRepoMock.createExecution.mockResolvedValue([{ id: 1 }]);
  tlsMonitorRepoMock.updateExecution.mockResolvedValue(undefined);

  heartbeatRepoMock.findOverdue.mockReset();
  heartbeatRepoMock.markOverdue.mockReset();
  heartbeatRepoMock.findOverdue.mockResolvedValue([]);
  heartbeatRepoMock.markOverdue.mockResolvedValue(null);

  monitorRegionRepoMock.forMonitor.mockReset();
  monitorRegionRepoMock.forMonitor.mockResolvedValue([]);

  qaProjectRepoMock.findDue.mockReset();
  qaProjectRepoMock.findTestsByProjectId.mockReset();
  qaProjectRepoMock.findAbandonedRuns.mockReset();
  qaProjectRepoMock.markRunTestsAbandoned.mockReset();
  qaProjectRepoMock.claimRunAlert.mockReset();
  qaProjectRepoMock.findDue.mockResolvedValue([]);
  qaProjectRepoMock.findTestsByProjectId.mockResolvedValue([]);
  qaProjectRepoMock.findAbandonedRuns.mockResolvedValue([]);
  qaProjectRepoMock.markRunTestsAbandoned.mockResolvedValue([]);
  qaProjectRepoMock.claimRunAlert.mockResolvedValue(true);

  dispatchAlertMock.mockReset();
  dispatchAlertMock.mockResolvedValue(undefined);

  finalizeUnfinishedQaRunMock.mockReset();
  finalizeUnfinishedQaRunMock.mockResolvedValue(false);

  execEventsMock.emit.mockReset();
  execEventsMock.emit.mockReturnValue(true);

  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  loggerMock.info.mockImplementation(() => {});
  loggerMock.warn.mockImplementation(() => {});
  loggerMock.error.mockImplementation(() => {});

  regionRepoMock.list.mockReset();
  regionRepoMock.list.mockResolvedValue([]);

  intervalCallback = null;
  intervalMs = null;
  clearedHandle = null;
}

function installTimerCapture() {
  globalThis.setInterval = ((cb: () => void, ms: number) => {
    intervalCallback = cb;
    intervalMs = ms;
    return 42 as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle: number) => {
    clearedHandle = handle;
  }) as typeof globalThis.clearInterval;
}

function restoreTimers() {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
}

function makeQueueFactory(): (name: string) => ReturnType<typeof makeQueueInstance> {
  const queues = new Map<string, ReturnType<typeof makeQueueInstance>>();
  return (name: string) => {
    let q = queues.get(name);
    if (!q) {
      q = makeQueueInstance(name);
      queues.set(name, q);
    }
    return q;
  };
}

beforeEach(() => {
  resetMocks();
  schedulerDeps.execEvents = execEventsMock as typeof schedulerDeps.execEvents;
  schedulerDeps.dispatchAlert = dispatchAlertMock;
  installTimerCapture();
});

afterEach(() => {
  restoreTimers();
  schedulerDeps.execEvents = originalSchedulerDeps.execEvents;
  schedulerDeps.dispatchAlert = originalSchedulerDeps.dispatchAlert;
});

describe('makeNonce', () => {
  test('is exactly 4 characters', () => {
    for (let i = 0; i < 20; i++) expect(makeNonce()).toHaveLength(4);
  });

  test('contains only lowercase letters and digits', () => {
    for (let i = 0; i < 20; i++) expect(makeNonce()).toMatch(/^[a-z0-9]{4}$/);
  });

  test('two calls produce distinct nonces (with overwhelming probability)', () => {
    const seen = new Set(Array.from({ length: 50 }, () => makeNonce()));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('jobIdSuffix', () => {
  test('master path (no region) returns empty string', () => {
    expect(jobIdSuffix({ regionId: null, regionSlug: null })).toBe('');
  });

  test('agent path returns -r<regionId>', () => {
    expect(jobIdSuffix({ regionId: 3, regionSlug: 'east' })).toBe('-r3');
    expect(jobIdSuffix({ regionId: 99, regionSlug: 'us-west' })).toBe('-r99');
  });
});

describe('buildJobId', () => {
  const TYPES = ['url', 'api', 'tcp', 'udp', 'db', 'tls', 'qa'] as const;
  const bucket = 12345;
  const nonce = 'ab12';
  const master = { regionId: null, regionSlug: null };
  const agent = { regionId: 3, regionSlug: 'east' };

  test('master-path ID has exactly 2 colons (BullMQ 3-part contract)', () => {
    for (const t of TYPES) {
      const id = buildJobId(t, 1, bucket, master, nonce);
      expect(id.split(':').length).toBe(3);
    }
  });

  test('agent-path ID also has exactly 2 colons', () => {
    for (const t of TYPES) {
      const id = buildJobId(t, 1, bucket, agent, nonce);
      expect(id.split(':').length).toBe(3);
      expect(id.endsWith('-r3')).toBe(true);
    }
  });

  test('different nonces produce different IDs for same monitor + bucket', () => {
    const id1 = buildJobId('url', 1, bucket, master, 'abcd');
    const id2 = buildJobId('url', 1, bucket, master, 'efgh');
    expect(id1).not.toBe(id2);
  });

  test('ID structure is <type>:<monitorId>:<bucket>-<nonce>[suffix]', () => {
    const id = buildJobId('url', 42, bucket, master, nonce);
    expect(id).toBe(`url:42:${bucket}-${nonce}`);

    const agentId = buildJobId('tcp', 7, bucket, agent, nonce);
    expect(agentId).toBe(`tcp:7:${bucket}-${nonce}-r3`);
  });
});

describe('startScheduler', () => {
  test('drains every known queue on startup and logs success', async () => {
    await startScheduler(redis as never);

    expect(queueDrainCalls).toEqual([
      'url-monitor',
      'api-check',
      'qa-project',
      'tcp-monitor',
      'udp-monitor',
      'db-monitor',
      'tls-monitor',
    ]);
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('startup: drained'));
  });

  test('logs a warning but survives when drain throws', async () => {
    // Cause one queue's drain to throw; the rest should still run.
    drainFailures.add('url-monitor');

    await startScheduler(redis as never);

    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringContaining('drain failed'));
    // Seven queues were still attempted.
    expect(queueDrainCalls).toHaveLength(7);
  });

  test('returns a stop function that clears the interval and closes queues', async () => {
    const stop = await startScheduler(redis as never);

    expect(intervalMs).toBe(100);
    await stop();

    expect(clearedHandle).toBe(42);
    expect(queueCloseCalls).toEqual([
      'url-monitor',
      'api-check',
      'qa-project',
      'tcp-monitor',
      'udp-monitor',
      'db-monitor',
      'tls-monitor',
    ]);
  });

  test('initial tick dispatches every monitor type', async () => {
    urlMonitorRepoMock.findDue.mockResolvedValue([
      { id: 1, url: 'https://a.test', timeoutMs: 5000, intervalSeconds: 60, ageSeconds: 120 },
    ]);
    apiCheckRepoMock.findDue.mockResolvedValue([
      {
        id: 2,
        url: 'https://api.test',
        method: 'POST',
        headers: { a: 'b' },
        body: '{}',
        timeoutMs: 5000,
        intervalSeconds: 60,
        ageSeconds: 120,
      },
    ]);
    tcpMonitorRepoMock.findDue.mockResolvedValue([
      {
        id: 3,
        host: 'tcp.test',
        port: 443,
        payloadHex: 'dead',
        expectBanner: 'hello',
        timeoutMs: 5000,
        intervalSeconds: 60,
        ageSeconds: 120,
      },
    ]);
    udpMonitorRepoMock.findDue.mockResolvedValue([
      {
        id: 4,
        host: 'udp.test',
        port: 53,
        payloadHex: 'cafe',
        expectResponse: true,
        timeoutMs: 5000,
        intervalSeconds: 60,
        ageSeconds: 120,
      },
    ]);
    dbMonitorRepoMock.findDue.mockResolvedValue([
      {
        id: 5,
        protocol: 'postgres',
        tls: true,
        host: 'db.test',
        port: 5432,
        timeoutMs: 5000,
        intervalSeconds: 60,
        ageSeconds: 120,
      },
    ]);
    tlsMonitorRepoMock.findDue.mockResolvedValue([
      {
        id: 6,
        host: 'tls.test',
        port: 443,
        servername: 'tls.test',
        warnDays: 14,
        timeoutMs: 5000,
        intervalSeconds: 60,
        ageSeconds: 120,
        verifyChain: true,
        verifyHostname: true,
        expectCnRegex: null,
      },
    ]);
    qaProjectRepoMock.findDue.mockResolvedValue([
      {
        id: 7,
        targetUrl: 'https://qa.test',
        credentials: { user: 'x' },
        config: { headless: true },
        intervalSeconds: 300,
        ageSeconds: 400,
      },
    ]);
    qaProjectRepoMock.findTestsByProjectId.mockResolvedValue([
      { id: 10, name: 'Login', script: 'test()' },
    ]);

    await startScheduler(redis as never);

    expect(queueAddCalls.map((c) => c.queue).sort()).toEqual([
      'api-check',
      'db-monitor',
      'qa-project',
      'tcp-monitor',
      'tls-monitor',
      'udp-monitor',
      'url-monitor',
    ]);
  });

  test('consecutive failures escalate at the threshold and doublings', async () => {
    urlMonitorRepoMock.findDue.mockRejectedValue(new Error('db down'));

    const stop = await startScheduler(redis as never);

    // Initial tick fails.
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('scheduler tick failed (#1)'),
    );

    // Second interval tick.
    intervalCallback?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('scheduler tick failed (#2)'),
    );

    // Third tick crosses threshold — first escalation.
    intervalCallback?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining('SCHEDULER STALLED'));

    // Fourth tick is not a doubling, so no extra stall message.
    const stallCountBefore = (loggerMock.error.mock.calls as string[][]).filter((c) =>
      c[0]?.includes('SCHEDULER STALLED'),
    ).length;
    intervalCallback?.();
    await new Promise((r) => setTimeout(r, 10));
    const stallCountAfter = (loggerMock.error.mock.calls as string[][]).filter((c) =>
      c[0]?.includes('SCHEDULER STALLED'),
    ).length;
    expect(stallCountAfter).toBe(stallCountBefore);

    // Sixth tick is a doubling (3 -> 6).
    intervalCallback?.();
    await new Promise((r) => setTimeout(r, 10));
    intervalCallback?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(
      (loggerMock.error.mock.calls as string[][]).filter((c) => c[0]?.includes('SCHEDULER STALLED'))
        .length,
    ).toBe(2);

    await stop();
  });

  test('recovery resets the consecutive failure counter', async () => {
    urlMonitorRepoMock.findDue.mockRejectedValueOnce(new Error('db down'));

    const stop = await startScheduler(redis as never);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('scheduler tick failed (#1)'),
    );

    // Next tick succeeds (findDue returns empty).
    urlMonitorRepoMock.findDue.mockResolvedValue([]);
    intervalCallback?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('scheduler recovered'));

    await stop();
  });
});

describe('tickUrlMonitors', () => {
  test('skips monitors that are not yet due', async () => {
    urlMonitorRepoMock.findDue.mockResolvedValue([
      { id: 1, url: 'https://a.test', timeoutMs: 5000, intervalSeconds: 60, ageSeconds: 30 },
    ]);

    await tickUrlMonitors(makeQueueFactory(), redis as never);

    expect(queueAddCalls).toHaveLength(0);
    expect(urlMonitorRepoMock.createExecution).not.toHaveBeenCalled();
  });

  test('dispatches a due monitor to the BullMQ queue', async () => {
    urlMonitorRepoMock.findDue.mockResolvedValue([
      { id: 1, url: 'https://a.test', timeoutMs: 5000, intervalSeconds: 60, ageSeconds: 120 },
    ]);
    urlMonitorRepoMock.findAssertionsByMonitorId.mockResolvedValue([
      { id: 10, operator: 'eq', statusCode: 200 },
    ]);

    await tickUrlMonitors(makeQueueFactory(), redis as never);

    expect(urlMonitorRepoMock.createExecution).toHaveBeenCalledWith(1, 'PENDING', null);
    expect(queueAddCalls).toHaveLength(1);
    const call = queueAddCalls[0];
    expect(call.queue).toBe('url-monitor');
    expect(call.name).toBe('check');
    expect(call.opts.jobId).toMatch(/^url:1:\d+-[a-z0-9]{4}$/);
    expect(call.data.monitor).toEqual({ id: 1, url: 'https://a.test', timeoutMs: 5000 });
    expect(call.data.assertions).toEqual([{ id: 10, operator: 'eq', statusCode: 200 }]);
    expect(call.opts).toMatchObject({ removeOnComplete: 200, removeOnFail: 200 });
  });

  test('dispatches to the regional Redis list when regions are attached', async () => {
    urlMonitorRepoMock.findDue.mockResolvedValue([
      { id: 2, url: 'https://b.test', timeoutMs: 5000, intervalSeconds: 60, ageSeconds: 120 },
    ]);
    monitorRegionRepoMock.forMonitor.mockResolvedValue([{ id: 3, slug: 'east', label: 'East' }]);

    await tickUrlMonitors(makeQueueFactory(), redis as never);

    expect(queueAddCalls).toHaveLength(0);
    expect(lpushCalls).toHaveLength(1);
    expect(lpushCalls[0].key).toBe('oo:jobs:east');
    expect(lpushCalls[0].payload.type).toBe('url');
    expect(lpushCalls[0].payload.regionId).toBe(3);
    expect(lpushCalls[0].payload.jobId).toMatch(/^url:2:\d+-[a-z0-9]{4}-r3$/);
  });

  test('marks execution FAILED when BullMQ dispatch fails', async () => {
    urlMonitorRepoMock.findDue.mockResolvedValue([
      { id: 1, url: 'https://a.test', timeoutMs: 5000, intervalSeconds: 60, ageSeconds: 120 },
    ]);
    const factory = makeQueueFactory();
    factory('url-monitor').add.mockRejectedValue(new Error('queue full'));

    await tickUrlMonitors(factory, redis as never);

    expect(urlMonitorRepoMock.updateExecution).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        status: 'FAILED',
        errorMessage: expect.stringContaining('queue full'),
      }),
    );
  });

  test('logs a second error when marking FAILED also fails', async () => {
    urlMonitorRepoMock.findDue.mockResolvedValue([
      { id: 1, url: 'https://a.test', timeoutMs: 5000, intervalSeconds: 60, ageSeconds: 120 },
    ]);
    urlMonitorRepoMock.updateExecution.mockRejectedValue(new Error('db gone'));
    const factory = makeQueueFactory();
    factory('url-monitor').add.mockRejectedValue(new Error('queue full'));

    await tickUrlMonitors(factory, redis as never);

    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining('could not mark exec #1 FAILED'),
    );
  });
});

describe('tickApiChecks', () => {
  test('dispatches a due API check with method, headers and body', async () => {
    apiCheckRepoMock.findDue.mockResolvedValue([
      {
        id: 5,
        url: 'https://api.test',
        method: 'POST',
        headers: { auth: 'bearer' },
        body: '{"x":1}',
        timeoutMs: 3000,
        intervalSeconds: 30,
        ageSeconds: 60,
      },
    ]);
    apiCheckRepoMock.findAssertionsByCheckId.mockResolvedValue([
      { id: 20, type: 'json', operator: 'eq', path: '$.ok', value: 'true' },
    ]);

    await tickApiChecks(makeQueueFactory(), redis as never);

    const call = queueAddCalls[0];
    expect(call.queue).toBe('api-check');
    expect(call.data.apiCheck).toEqual({
      id: 5,
      url: 'https://api.test',
      method: 'POST',
      headers: { auth: 'bearer' },
      body: '{"x":1}',
      timeoutMs: 3000,
    });
    expect(call.data.assertions).toHaveLength(1);
  });

  test('uses the regional Redis path when bound to a region', async () => {
    apiCheckRepoMock.findDue.mockResolvedValue([
      {
        id: 6,
        url: 'https://api.test',
        method: 'GET',
        headers: {},
        body: null,
        timeoutMs: 3000,
        intervalSeconds: 30,
        ageSeconds: 60,
      },
    ]);
    monitorRegionRepoMock.forMonitor.mockResolvedValue([
      { id: 7, slug: 'us-west', label: 'US West' },
    ]);

    await tickApiChecks(makeQueueFactory(), redis as never);

    expect(lpushCalls[0].key).toBe('oo:jobs:us-west');
  });
});

describe('tickTcpMonitors', () => {
  test('dispatches TCP monitor payload', async () => {
    tcpMonitorRepoMock.findDue.mockResolvedValue([
      {
        id: 8,
        host: 'tcp.test',
        port: 443,
        payloadHex: 'deadbeef',
        expectBanner: 'welcome',
        timeoutMs: 2000,
        intervalSeconds: 60,
        ageSeconds: 120,
      },
    ]);

    await tickTcpMonitors(makeQueueFactory(), redis as never);

    const call = queueAddCalls[0];
    expect(call.queue).toBe('tcp-monitor');
    expect(call.data.monitor).toEqual({
      id: 8,
      host: 'tcp.test',
      port: 443,
      payloadHex: 'deadbeef',
      expectBanner: 'welcome',
      timeoutMs: 2000,
    });
  });
});

describe('tickUdpMonitors', () => {
  test('dispatches UDP monitor payload', async () => {
    udpMonitorRepoMock.findDue.mockResolvedValue([
      {
        id: 9,
        host: 'udp.test',
        port: 53,
        payloadHex: 'cafe',
        expectResponse: true,
        timeoutMs: 2000,
        intervalSeconds: 60,
        ageSeconds: 120,
      },
    ]);

    await tickUdpMonitors(makeQueueFactory(), redis as never);

    const call = queueAddCalls[0];
    expect(call.queue).toBe('udp-monitor');
    expect(call.data.monitor).toEqual({
      id: 9,
      host: 'udp.test',
      port: 53,
      payloadHex: 'cafe',
      expectResponse: true,
      timeoutMs: 2000,
    });
  });
});

describe('tickDbMonitors', () => {
  test('dispatches DB monitor payload', async () => {
    dbMonitorRepoMock.findDue.mockResolvedValue([
      {
        id: 10,
        protocol: 'mysql',
        tls: false,
        host: 'db.test',
        port: 3306,
        timeoutMs: 3000,
        intervalSeconds: 60,
        ageSeconds: 120,
      },
    ]);

    await tickDbMonitors(makeQueueFactory(), redis as never);

    const call = queueAddCalls[0];
    expect(call.queue).toBe('db-monitor');
    expect(call.data.monitor).toEqual({
      id: 10,
      protocol: 'mysql',
      tls: false,
      host: 'db.test',
      port: 3306,
      timeoutMs: 3000,
    });
  });
});

describe('tickTlsMonitors', () => {
  test('dispatches TLS monitor payload with verification options', async () => {
    tlsMonitorRepoMock.findDue.mockResolvedValue([
      {
        id: 11,
        host: 'tls.test',
        port: 443,
        servername: 'tls.test',
        warnDays: 30,
        timeoutMs: 5000,
        intervalSeconds: 3600,
        ageSeconds: 4000,
        verifyChain: true,
        verifyHostname: true,
        expectCnRegex: '.*',
      },
    ]);

    await tickTlsMonitors(makeQueueFactory(), redis as never);

    const call = queueAddCalls[0];
    expect(call.queue).toBe('tls-monitor');
    expect(call.data.monitor).toEqual({
      id: 11,
      host: 'tls.test',
      port: 443,
      servername: 'tls.test',
      warnDays: 30,
      timeoutMs: 5000,
      verifyChain: true,
      verifyHostname: true,
      expectCnRegex: '.*',
    });
  });
});

describe('tickQaProjects', () => {
  test('skips projects with no tests', async () => {
    qaProjectRepoMock.findDue.mockResolvedValue([
      {
        id: 12,
        targetUrl: 'https://qa.test',
        credentials: null,
        config: {},
        intervalSeconds: 300,
        ageSeconds: 400,
      },
    ]);
    qaProjectRepoMock.findTestsByProjectId.mockResolvedValue([]);

    await tickQaProjects(makeQueueFactory(), redis as never);

    expect(qaProjectRepoMock.findTestsByProjectId).toHaveBeenCalledWith(12, {
      includeScript: true,
    });
    expect(queueAddCalls).toHaveLength(0);
  });

  test('dispatches a QA project run to BullMQ with tests and config', async () => {
    qaProjectRepoMock.findDue.mockResolvedValue([
      {
        id: 13,
        targetUrl: 'https://qa.test',
        credentials: { user: 'u' },
        config: { headless: false },
        intervalSeconds: 300,
        ageSeconds: 400,
      },
    ]);
    qaProjectRepoMock.findTestsByProjectId.mockResolvedValue([
      { id: 100, name: 'Checkout', script: 'test()' },
    ]);

    await tickQaProjects(makeQueueFactory(), redis as never);

    const call = queueAddCalls[0];
    expect(call.queue).toBe('qa-project');
    expect(call.data.kind).toBe('qa-project-run');
    expect(call.data.projectId).toBe(13);
    expect(call.data.targetUrl).toBe('https://qa.test');
    expect(call.data.credentials).toEqual({ user: 'u' });
    expect(call.data.config).toEqual({ headless: false });
    expect(call.data.tests).toEqual([{ id: 100, name: 'Checkout', script: 'test()' }]);
    expect(call.opts).toMatchObject({ removeOnComplete: 50, removeOnFail: 50 });
  });

  test('dispatches QA project to regional list', async () => {
    qaProjectRepoMock.findDue.mockResolvedValue([
      {
        id: 14,
        targetUrl: 'https://qa.test',
        credentials: null,
        config: {},
        intervalSeconds: 300,
        ageSeconds: 400,
      },
    ]);
    qaProjectRepoMock.findTestsByProjectId.mockResolvedValue([
      { id: 101, name: 'Login', script: 'test()' },
    ]);
    monitorRegionRepoMock.forMonitor.mockResolvedValue([{ id: 4, slug: 'eu', label: 'EU' }]);

    await tickQaProjects(makeQueueFactory(), redis as never);

    expect(lpushCalls).toHaveLength(1);
    expect(lpushCalls[0].key).toBe('oo:jobs:eu');
    expect(lpushCalls[0].payload.type).toBe('qa');
  });
});

describe('tickAbandonedQaRuns', () => {
  test('finalizes abandoned runs and logs the abandonment', async () => {
    const startedAt = new Date(Date.now() - 90_000);
    qaProjectRepoMock.findAbandonedRuns.mockResolvedValue([
      { id: 200, projectId: 13, regionId: null, startedAt, expectedTests: 3 },
    ]);
    finalizeUnfinishedQaRunMock.mockResolvedValue(true);

    await tickAbandonedQaRuns();

    expect(finalizeUnfinishedQaRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 200, projectId: 13 }),
      expect.stringContaining('abandoned: run produced no result'),
    );
    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining('ABANDONED'));
  });

  test('does not log when another caller already finalized the run', async () => {
    qaProjectRepoMock.findAbandonedRuns.mockResolvedValue([
      {
        id: 201,
        projectId: 13,
        regionId: null,
        startedAt: new Date(Date.now() - 90_000),
        expectedTests: 3,
      },
    ]);
    finalizeUnfinishedQaRunMock.mockResolvedValue(false);

    await tickAbandonedQaRuns();

    const errorCalls = (loggerMock.error.mock.calls as string[][]).filter((c) =>
      c[0]?.includes('ABANDONED'),
    );
    expect(errorCalls).toHaveLength(0);
  });
});

describe('tickRegionStatus', () => {
  test('first sweep records state without emitting events', async () => {
    regionRepoMock.list.mockResolvedValue([
      {
        id: 1,
        slug: 'east',
        label: 'East',
        apiKeyId: 10,
        lastSeenAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    await tickRegionStatus();

    expect(execEventsMock.emit).not.toHaveBeenCalled();
  });

  test('emits offline when a region stops checking in', async () => {
    const now = new Date();
    regionRepoMock.list.mockResolvedValue([
      { id: 1, slug: 'east', label: 'East', apiKeyId: 10, lastSeenAt: now, createdAt: now },
    ]);
    await tickRegionStatus();

    const stale = new Date(now.getTime() - 120_000);
    regionRepoMock.list.mockResolvedValue([
      { id: 1, slug: 'east', label: 'East', apiKeyId: 10, lastSeenAt: stale, createdAt: now },
    ]);
    await tickRegionStatus();

    expect(execEventsMock.emit).toHaveBeenCalledWith('region', {
      regionId: 1,
      status: 'offline',
      lastSeenAt: stale.toISOString(),
    });
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('offline'));
  });

  test('emits online when a region comes back', async () => {
    const now = new Date();
    regionRepoMock.list.mockResolvedValue([
      {
        id: 1,
        slug: 'east',
        label: 'East',
        apiKeyId: 10,
        lastSeenAt: new Date(now.getTime() - 120_000),
        createdAt: now,
      },
    ]);
    await tickRegionStatus();

    regionRepoMock.list.mockResolvedValue([
      { id: 1, slug: 'east', label: 'East', apiKeyId: 10, lastSeenAt: now, createdAt: now },
    ]);
    await tickRegionStatus();

    expect(execEventsMock.emit).toHaveBeenCalledWith('region', {
      regionId: 1,
      status: 'online',
      lastSeenAt: now.toISOString(),
    });
  });

  test('no transition produces no event', async () => {
    const now = new Date();
    regionRepoMock.list.mockResolvedValue([
      { id: 1, slug: 'east', label: 'East', apiKeyId: 10, lastSeenAt: now, createdAt: now },
    ]);
    await tickRegionStatus();
    execEventsMock.emit.mockClear();

    regionRepoMock.list.mockResolvedValue([
      {
        id: 1,
        slug: 'east',
        label: 'East',
        apiKeyId: 10,
        lastSeenAt: new Date(now.getTime() + 1000),
        createdAt: now,
      },
    ]);
    await tickRegionStatus();

    expect(execEventsMock.emit).not.toHaveBeenCalled();
  });
});

describe('tickHeartbeats', () => {
  test('marks overdue heartbeats and dispatches outage alerts', async () => {
    heartbeatRepoMock.findOverdue.mockResolvedValue([
      {
        id: 20,
        name: 'cron',
        periodSeconds: 60,
        graceSeconds: 30,
        lastPingAt: new Date(Date.now() - 120_000),
        status: 'UP',
        enabled: true,
      },
    ]);
    heartbeatRepoMock.markOverdue.mockResolvedValue({ id: 20, name: 'cron', status: 'OVERDUE' });

    await tickHeartbeats();

    expect(heartbeatRepoMock.markOverdue).toHaveBeenCalledWith(20);
    expect(execEventsMock.emit).toHaveBeenCalledWith(
      'monitor-state',
      expect.objectContaining({ type: 'heartbeat', monitorId: 20, status: 'OVERDUE' }),
    );
    expect(dispatchAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        monitor: { type: 'heartbeat', id: 20, name: 'cron', target: 'cron' },
        event: 'outage',
        status: 'FAILED',
        errorMessage: expect.stringContaining('no ping in'),
      }),
    );
  });

  test('uses "no ping received yet" message when lastPingAt is null', async () => {
    heartbeatRepoMock.findOverdue.mockResolvedValue([
      {
        id: 21,
        name: 'fresh',
        periodSeconds: 60,
        graceSeconds: 30,
        lastPingAt: null,
        status: 'UP',
        enabled: true,
      },
    ]);
    heartbeatRepoMock.markOverdue.mockResolvedValue({ id: 21, name: 'fresh', status: 'OVERDUE' });

    await tickHeartbeats();

    expect(dispatchAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: 'no ping received yet' }),
    );
  });

  test('skips alerting when markOverdue returns null', async () => {
    heartbeatRepoMock.findOverdue.mockResolvedValue([
      {
        id: 22,
        name: 'already',
        periodSeconds: 60,
        graceSeconds: 30,
        lastPingAt: new Date(Date.now() - 120_000),
        status: 'UP',
        enabled: true,
      },
    ]);
    heartbeatRepoMock.markOverdue.mockResolvedValue(null);

    await tickHeartbeats();

    expect(dispatchAlertMock).not.toHaveBeenCalled();
    expect(execEventsMock.emit).not.toHaveBeenCalled();
  });
});
