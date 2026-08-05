/**
 * Agent contract — poll loop, per-type probes, QA handling, master POSTs.
 *
 * All external I/O is mocked: fetch (master long-poll and result posts),
 * the network probes, assertion evaluators, Playwright, the file system
 * browser-detection read, and logging. The goal is to exercise every branch
 * in src/agent.ts without spinning up services.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realPlaywright from './services/playwright.service.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentConfig, JobPayload } from './agent.ts';

const MASTER = 'https://master.test';
const AGENT_KEY = 'oo_agentkey42';

/** Create a temp directory containing the given browser-entry names. */
async function makeBrowserDir(entries: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oo-agent-browser-'));
  tempDirs.push(dir);
  for (const entry of entries) {
    await mkdir(join(dir, entry));
  }
  return dir;
}

/** Create a real temp file with the given content and return its path. */
async function makeArtifactFile(content: Buffer | string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'oo-agent-artifact-'));
  tempDirs.push(dir);
  const file = join(dir, 'trace.zip');
  await writeFile(file, content);
  return file;
}

const baseCfg: AgentConfig = {
  masterUrl: MASTER,
  agentKey: AGENT_KEY,
  regionSlug: 'us-east',
  pollWaitSec: 30,
  tlsInsecure: false,
  pollTimeoutMs: 100,
};

function makeJob(over: Partial<JobPayload> = {}): JobPayload {
  return {
    jobId: 'job-1',
    type: 'url',
    executionId: 1,
    regionId: 1,
    monitor: { id: 10, url: 'https://target.test', timeoutMs: 1000 },
    ...over,
  } as JobPayload;
}

// ---- Module mocks (registered before importing agent.ts) ----

const probeMocks = {
  tcpProbe: mock(async () => ({
    ok: true,
    latencyMs: 12,
    banner: 'SSH-2.0-test',
    errorMessage: null as string | null,
  })),
  dbProbe: mock(async () => ({
    ok: true,
    latencyMs: 9,
    errorMessage: null as string | null,
  })),
  tlsProbe: mock(async () => ({
    ok: true,
    latencyMs: 22,
    daysRemaining: 45,
    validTo: new Date('2027-01-01T00:00:00.000Z'),
    certSummary: 'CN=test; issuer= issuer; valid_to=Jan 1 2027',
    errorMessage: null as string | null,
  })),
};

mock.module('./services/tcp-probe.ts', () => ({ tcpProbe: probeMocks.tcpProbe }));
mock.module('./services/db-probe.ts', () => ({ dbProbe: probeMocks.dbProbe }));
mock.module('./services/tls-probe.ts', () => ({ tlsProbe: probeMocks.tlsProbe }));

const loggerCalls = { info: [] as string[], warn: [] as string[], error: [] as string[] };
const loggerMock = {
  info: mock((m: string) => loggerCalls.info.push(m)),
  warn: mock((m: string) => loggerCalls.warn.push(m)),
  error: mock((m: string) => loggerCalls.error.push(m)),
};
mock.module('./utils/logger.ts', () => ({ logger: loggerMock }));

const packageVersionMock = mock(() => '1.29.0');
mock.module('./utils/version.ts', () => ({ packageVersion: packageVersionMock }));

const executePlaywrightTestMock = mock<
  () => Promise<{
    success: boolean;
    error: string | null;
    logs: string[];
    artifacts: { name: string; path: string; contentType: string }[];
    duration_ms: number;
  }>
>(async () => ({
  success: true,
  error: null,
  logs: [],
  artifacts: [],
  duration_ms: 42,
}));
mock.module('./services/playwright.service.ts', () => ({
  ...realPlaywright,
  executePlaywrightTest: executePlaywrightTestMock,
}));

// ---- Fetch mock (global, restored after each test) ----

let fetchHandler: (url: string, init: RequestInit) => Response | Promise<Response>;
const fetchMock = mock(async (url: URL | RequestInfo, init?: RequestInit | BunFetchRequestInit) => {
  const urlStr = typeof url === 'string' ? url : url.toString();
  return fetchHandler(urlStr, (init ?? {}) as RequestInit);
});

let originalFetch: typeof fetch;
let originalProcessOn: typeof process.on;
let originalSetTimeout: typeof setTimeout;
let originalDateNow: typeof Date.now;
let originalHome: string | undefined;
let sigintHandler: (() => void) | undefined;
let sigtermHandler: (() => void) | undefined;
const tempDirs: string[] = [];

const realDateNow = Date.now;

const agent = await import('./agent.ts');
const {
  pollJob,
  postResult,
  runProbe,
  handleQaJob,
  runAgent,
  _resetPlaywrightDetected,
  masterFetchInit,
} = agent;

beforeEach(() => {
  // Reset captured calls.
  loggerCalls.info.length = 0;
  loggerCalls.warn.length = 0;
  loggerCalls.error.length = 0;

  // Reset mock behaviors.
  probeMocks.tcpProbe.mockReset();
  probeMocks.dbProbe.mockReset();
  probeMocks.tlsProbe.mockReset();
  packageVersionMock.mockReset();
  executePlaywrightTestMock.mockReset();
  fetchMock.mockClear();

  // Default happy-path responses.
  probeMocks.tcpProbe.mockResolvedValue({
    ok: true,
    latencyMs: 12,
    banner: 'SSH-2.0-test',
    errorMessage: null,
  });
  probeMocks.dbProbe.mockResolvedValue({ ok: true, latencyMs: 9, errorMessage: null });
  probeMocks.tlsProbe.mockResolvedValue({
    ok: true,
    latencyMs: 22,
    daysRemaining: 45,
    validTo: new Date('2027-01-01T00:00:00.000Z'),
    certSummary: 'CN=test; issuer= issuer; valid_to=Jan 1 2027',
    errorMessage: null,
  });
  packageVersionMock.mockReturnValue('1.29.0');
  executePlaywrightTestMock.mockResolvedValue({
    success: true,
    error: null,
    logs: [],
    artifacts: [],
    duration_ms: 42,
  });

  // Reset Playwright browser cache and env.
  _resetPlaywrightDetected();
  delete process.env.OO_AGENT_FORCE_LIGHT;

  // Fetch default: empty long-poll, QA executions endpoint returns one execution.
  fetchHandler = (url) => {
    if (typeof url === 'string' && url.includes('/api/agent/qa/executions')) {
      return new Response(JSON.stringify({ executions: [{ testId: 1, executionId: 601 }] }), {
        status: 200,
      });
    }
    return new Response(null, { status: 204 });
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  // Capture signal handlers so tests can stop runAgent.
  sigintHandler = undefined;
  sigtermHandler = undefined;
  originalProcessOn = process.on;
  process.on = ((event: string | symbol, handler: (...args: any[]) => void) => {
    if (event === 'SIGINT') sigintHandler = handler as () => void;
    if (event === 'SIGTERM') sigtermHandler = handler as () => void;
    return process;
  }) as typeof process.on;

  originalSetTimeout = globalThis.setTimeout;
  originalDateNow = Date.now;
  originalHome = process.env.HOME;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.on = originalProcessOn;
  globalThis.setTimeout = originalSetTimeout;
  Date.now = originalDateNow;
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  delete process.env.OO_AGENT_FORCE_LIGHT;
  delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
  tempDirs.length = 0;
});

// ---- Helpers ----

function findFetchCall(
  predicate: (url: string, init: RequestInit) => boolean,
): [string, RequestInit] | undefined {
  for (const call of fetchMock.mock.calls) {
    const [url, init] = call as [string | Request | URL, RequestInit | undefined];
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (predicate(urlStr, init ?? {})) return [urlStr, init ?? {}];
  }
  return undefined;
}

async function runAgentUntil(
  cfg: AgentConfig,
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const controller = new AbortController();
  const runPromise = runAgent(cfg, controller.signal);
  const start = realDateNow();
  while (realDateNow() - start < timeoutMs) {
    await Bun.sleep(5);
    if (predicate()) break;
  }
  controller.abort();
  await runPromise;
}

// ==================== pollJob ====================

describe('pollJob', () => {
  test('returns null when master responds 204', async () => {
    fetchHandler = () => new Response(null, { status: 204 });

    const job = await pollJob(baseCfg);

    expect(job).toBeNull();
    const call = findFetchCall((u) => u.includes('/api/agent/jobs'));
    expect(call).toBeDefined();
    const [, init] = call!;
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${AGENT_KEY}`,
      Connection: 'close',
      'X-Agent-Version': '1.29.0',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('returns the job payload on 200', async () => {
    const payload: JobPayload = makeJob({
      type: 'tcp',
      monitor: { id: 5, host: 'db.test', port: 5432, timeoutMs: 2000 },
    });
    fetchHandler = () => new Response(JSON.stringify(payload), { status: 200 });

    const job = await pollJob(baseCfg);

    expect(job).toEqual(payload);
  });

  test('throws when master returns a non-ok status', async () => {
    fetchHandler = () => new Response('unauthorized', { status: 401 });

    await expect(pollJob(baseCfg)).rejects.toThrow(
      'master returned 401 on /api/agent/jobs: unauthorized',
    );
  });

  test('includes the text body even when res.text() resolves slowly', async () => {
    fetchHandler = () =>
      new Response('bad gateway', {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      });

    await expect(pollJob(baseCfg)).rejects.toThrow(
      'master returned 502 on /api/agent/jobs: bad gateway',
    );
  });

  test('masterFetchInit adds tls.rejectUnauthorized=false when tlsInsecure is on', () => {
    const init = masterFetchInit({ ...baseCfg, tlsInsecure: true }, { method: 'GET' });
    expect((init as RequestInit & { tls: { rejectUnauthorized: boolean } }).tls).toEqual({
      rejectUnauthorized: false,
    });
  });

  test('masterFetchInit does not add tls option when tlsInsecure is off', () => {
    const init = masterFetchInit(baseCfg, { method: 'GET' });
    expect((init as RequestInit & { tls?: unknown }).tls).toBeUndefined();
  });
});

// ==================== postResult ====================

describe('postResult', () => {
  test('POSTs the result body and succeeds on 204', async () => {
    let postedBody: Record<string, unknown> | undefined;
    fetchHandler = (_url, init) => {
      postedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    };

    await postResult(baseCfg, {
      type: 'url',
      executionId: 1,
      status: 'SUCCESS',
      latencyMs: 10,
    });

    expect(postedBody).toMatchObject({ type: 'url', executionId: 1, status: 'SUCCESS' });
    const call = findFetchCall((u) => u.includes('/api/agent/results'));
    expect(call?.[1].method).toBe('POST');
    expect(call?.[1].headers).toMatchObject({
      Authorization: `Bearer ${AGENT_KEY}`,
      'content-type': 'application/json',
      Connection: 'close',
    });
  });

  test('throws when master rejects the result post', async () => {
    fetchHandler = () => new Response('conflict', { status: 409 });

    await expect(
      postResult(baseCfg, { type: 'url', executionId: 1, status: 'SUCCESS' }),
    ).rejects.toThrow('master returned 409 on /api/agent/results: conflict');
  });

  test('uses tls.rejectUnauthorized=false for result post when tlsInsecure is on', async () => {
    fetchHandler = (_url, init) => {
      expect((init as RequestInit & { tls?: { rejectUnauthorized: boolean } }).tls).toEqual({
        rejectUnauthorized: false,
      });
      return new Response(null, { status: 204 });
    };

    await postResult(
      { ...baseCfg, tlsInsecure: true },
      {
        type: 'url',
        executionId: 1,
        status: 'SUCCESS',
      },
    );
  });
});

// ==================== runProbe / per-type probes ====================

describe('runProbe', () => {
  test('url probe: SUCCESS on 200', async () => {
    fetchHandler = () => new Response(null, { status: 200 });

    const result = await runProbe(
      makeJob({ type: 'url', monitor: { id: 1, url: 'https://url.test', timeoutMs: 1000 } }),
    );

    expect(result).toMatchObject({
      type: 'url',
      executionId: 1,
      status: 'SUCCESS',
      statusCode: 200,
      errorMessage: null,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test('url probe: FAILED on fetch error with classified message', async () => {
    fetchHandler = () => {
      const err = new Error('fetch failed');
      (err as { cause?: { code: string } }).cause = { code: 'ECONNREFUSED' };
      throw err;
    };

    const result = await runProbe(
      makeJob({ type: 'url', monitor: { id: 1, url: 'https://url.test', timeoutMs: 1000 } }),
    );

    expect(result.status).toBe('FAILED');
    expect(result.errorMessage).toContain('Connection refused');
  });

  test('api probe: GET success with passing assertions', async () => {
    fetchHandler = () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const result = await runProbe(
      makeJob({
        type: 'api',
        monitor: undefined,
        apiCheck: { id: 2, url: 'https://api.test/health', method: 'GET', timeoutMs: 1000 },
      }),
    );

    expect(result).toMatchObject({
      type: 'api',
      executionId: 1,
      status: 'SUCCESS',
      responseStatus: 200,
      responseBody: '{"ok":true}',
      errorMessage: null,
    });
    expect(result.responseHeaders).toMatchObject({ 'content-type': 'application/json' });
  });

  test('api probe: POST serializes the body and adds content-type', async () => {
    let capturedInit: RequestInit | undefined;
    fetchHandler = (_url, init) => {
      capturedInit = init;
      return new Response('created', { status: 201 });
    };

    await runProbe(
      makeJob({
        type: 'api',
        monitor: undefined,
        apiCheck: {
          id: 2,
          url: 'https://api.test/items',
          method: 'POST',
          headers: { 'X-Custom': 'yes' },
          body: JSON.stringify({ name: 'x' }),
          timeoutMs: 1000,
        },
      }),
    );

    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.body).toBe('{"name":"x"}');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Custom']).toBe('yes');
  });

  test('api probe: body is ignored for GET', async () => {
    let capturedInit: RequestInit | undefined;
    fetchHandler = (_url, init) => {
      capturedInit = init;
      return new Response('ok', { status: 200 });
    };

    await runProbe(
      makeJob({
        type: 'api',
        monitor: undefined,
        apiCheck: {
          id: 2,
          url: 'https://api.test/items',
          method: 'GET',
          body: JSON.stringify({ name: 'x' }),
          timeoutMs: 1000,
        },
      }),
    );

    expect(capturedInit?.body).toBeUndefined();
  });

  test('api probe: FAILED on fetch timeout', async () => {
    fetchHandler = () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    };

    const result = await runProbe(
      makeJob({
        type: 'api',
        monitor: undefined,
        apiCheck: { id: 2, url: 'https://api.test', method: 'GET', timeoutMs: 500 },
      }),
    );

    expect(result.status).toBe('FAILED');
    expect(result.errorMessage).toBe('Request timed out after 500ms');
  });

  test('tcp probe: SUCCESS', async () => {
    const result = await runProbe(
      makeJob({
        type: 'tcp',
        monitor: { id: 3, host: 'tcp.test', port: 22, timeoutMs: 1000 },
      }),
    );

    expect(probeMocks.tcpProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'tcp.test',
        port: 22,
        timeoutMs: 1000,
        payload: null,
        expectBanner: null,
      }),
    );
    expect(result).toMatchObject({
      type: 'tcp',
      status: 'SUCCESS',
      latencyMs: 12,
      banner: 'SSH-2.0-test',
    });
  });

  test('tcp probe: FAILED on invalid hex payload', async () => {
    const result = await runProbe(
      makeJob({
        type: 'tcp',
        monitor: { id: 3, host: 'tcp.test', port: 22, timeoutMs: 1000, payloadHex: 'abc' },
      }),
    );

    expect(probeMocks.tcpProbe).not.toHaveBeenCalled();
    expect(result.status).toBe('FAILED');
    expect(result.errorMessage).toContain('even-length');
  });

  test('tcp probe: FAILED when tcpProbe reports failure', async () => {
    probeMocks.tcpProbe.mockResolvedValue({
      ok: false,
      latencyMs: 5,
      banner: '',
      errorMessage: 'connection refused',
    });

    const result = await runProbe(
      makeJob({
        type: 'tcp',
        monitor: { id: 3, host: 'tcp.test', port: 22, timeoutMs: 1000, payloadHex: 'deadbeef' },
      }),
    );

    expect(probeMocks.tcpProbe).toHaveBeenCalledWith(
      expect.objectContaining({ payload: Buffer.from([0xde, 0xad, 0xbe, 0xef]) }),
    );
    expect(result).toMatchObject({
      type: 'tcp',
      status: 'FAILED',
      errorMessage: 'connection refused',
    });
  });

  test('db probe: SUCCESS', async () => {
    const result = await runProbe(
      makeJob({
        type: 'db',
        monitor: {
          id: 5,
          host: 'db.test',
          port: 5432,
          protocol: 'postgres',
          tls: true,
          timeoutMs: 1000,
        },
      }),
    );

    expect(probeMocks.dbProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'db.test',
        port: 5432,
        protocol: 'postgres',
        tls: true,
        timeoutMs: 1000,
      }),
    );
    expect(result).toMatchObject({ type: 'db', status: 'SUCCESS', latencyMs: 9 });
  });

  test('db probe: FAILED', async () => {
    probeMocks.dbProbe.mockResolvedValue({
      ok: false,
      latencyMs: 3,
      errorMessage: 'connection refused',
    });

    const result = await runProbe(
      makeJob({
        type: 'db',
        monitor: { id: 5, host: 'db.test', port: 5432, protocol: 'mysql', timeoutMs: 1000 },
      }),
    );

    expect(result).toMatchObject({
      type: 'db',
      status: 'FAILED',
      errorMessage: 'connection refused',
    });
  });

  test('tls probe: SUCCESS', async () => {
    const result = await runProbe(
      makeJob({
        type: 'tls',
        monitor: {
          id: 6,
          host: 'tls.test',
          port: 443,
          timeoutMs: 1000,
          warnDays: 30,
          servername: 'sni.test',
        },
      }),
    );

    expect(probeMocks.tlsProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'tls.test',
        port: 443,
        timeoutMs: 1000,
        warnDays: 30,
        servername: 'sni.test',
      }),
    );
    expect(result).toMatchObject({ type: 'tls', status: 'SUCCESS', daysRemaining: 45 });
    expect(result.validTo).toBe('2027-01-01T00:00:00.000Z');
  });

  test('tls probe: FAILED', async () => {
    probeMocks.tlsProbe.mockResolvedValue({
      ok: false,
      latencyMs: 3,
      daysRemaining: 5,
      validTo: new Date('2026-08-10T00:00:00.000Z'),
      certSummary: 'CN=expiring',
      errorMessage: 'expires soon',
    });

    const result = await runProbe(
      makeJob({
        type: 'tls',
        monitor: { id: 6, host: 'tls.test', port: 443, timeoutMs: 1000 },
      }),
    );

    expect(result).toMatchObject({ type: 'tls', status: 'FAILED', errorMessage: 'expires soon' });
  });

  test('runProbe throws for qa type', async () => {
    await expect(runProbe(makeJob({ type: 'qa' }))).rejects.toThrow('runProbe(qa) is not callable');
  });

  test('runProbe throws for unknown type', async () => {
    await expect(runProbe(makeJob({ type: 'unknown' as never }))).rejects.toThrow(
      'unhandled monitor type',
    );
  });
});

// ==================== handleQaJob / QA helpers ====================

describe('handleQaJob', () => {
  function makeQaJob(over: Partial<JobPayload> = {}): JobPayload {
    return makeJob({
      type: 'qa',
      projectId: 7,
      targetUrl: 'https://shop.test',
      credentials: { user: 'u' },
      config: {},
      tests: [{ id: 71, name: 'Login', script: 'test("login", () => {})' }],
      monitor: undefined,
      ...over,
    });
  }

  test('skips when projectId or tests are missing', async () => {
    await handleQaJob(
      baseCfg,
      makeQaJob({ projectId: undefined, tests: [{ id: 1, name: 't', script: 's' }] }),
    );
    await handleQaJob(baseCfg, makeQaJob({ projectId: 7, tests: [] }));

    expect(loggerCalls.warn.some((m) => m.includes('missing projectId or tests'))).toBe(true);
    expect(findFetchCall((u) => u.includes('/api/agent/qa/executions'))).toBeUndefined();
  });

  test('light image reports ERROR via createQaExecutions + postResult', async () => {
    process.env.OO_AGENT_FORCE_LIGHT = '1';
    fetchHandler = (url, init) => {
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 71, executionId: 501 }] }), {
          status: 200,
        });
      }
      if (url.includes('/api/agent/results')) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body).toMatchObject({ type: 'qa', executionId: 501, status: 'ERROR' });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    };

    await handleQaJob(baseCfg, makeQaJob());

    expect(findFetchCall((u) => u.includes('/api/agent/qa/executions'))).toBeDefined();
  });

  test('light image: createQaExecutions failure is logged and does not throw', async () => {
    process.env.OO_AGENT_FORCE_LIGHT = '1';
    fetchHandler = (url) => {
      if (url.includes('/api/agent/qa/executions')) return new Response('boom', { status: 500 });
      return new Response(null, { status: 204 });
    };

    await handleQaJob(baseCfg, makeQaJob());

    expect(loggerCalls.error.some((m) => m.includes('create-executions failed'))).toBe(true);
  });

  test('runs a passing test and posts SUCCESS', async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = await makeBrowserDir(['chromium-headless-shell']);
    fetchHandler = (url, init) => {
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 71, executionId: 502 }] }), {
          status: 200,
        });
      }
      if (url.includes('/api/agent/results')) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body).toMatchObject({
          type: 'qa',
          executionId: 502,
          status: 'SUCCESS',
          latencyMs: 42,
        });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    };

    await handleQaJob(baseCfg, makeQaJob());

    expect(executePlaywrightTestMock).toHaveBeenCalledWith(
      expect.stringContaining('login.spec.ts'),
      'https://shop.test',
      { user: 'u' },
      expect.objectContaining({ outputDir: expect.stringContaining('out-71') }),
    );
  });

  test('failing test uploads artifacts with retry then success', async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = await makeBrowserDir(['chromium-headless-shell']);
    const artifactPath = await makeArtifactFile(Buffer.alloc(123));
    executePlaywrightTestMock.mockResolvedValue({
      success: false,
      error: 'expected 200',
      logs: ['boom'],
      artifacts: [{ name: 'trace', path: artifactPath, contentType: 'application/zip' }],
      duration_ms: 30,
    });
    let artifactAttempts = 0;
    fetchHandler = (url, init) => {
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 71, executionId: 503 }] }), {
          status: 200,
        });
      }
      if (url.includes('/api/agent/qa/artifacts')) {
        artifactAttempts++;
        if (artifactAttempts === 1) return new Response('bad', { status: 503 });
        return new Response(JSON.stringify({ key: 'trace-key' }), { status: 200 });
      }
      if (url.includes('/api/agent/results')) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body).toMatchObject({ status: 'FAILED', traceUrl: 'trace-key' });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    };
    // Make the 500ms artifact-upload retry immediate.
    globalThis.setTimeout = ((cb: TimerHandler, _ms?: number, ...args: unknown[]) =>
      originalSetTimeout(cb, 0, ...args)) as typeof setTimeout;

    await handleQaJob(baseCfg, makeQaJob());

    expect(artifactAttempts).toBe(2);
  });

  test('two consecutive artifact upload failures drop the artifact but still post FAILED', async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = await makeBrowserDir(['chromium-headless-shell']);
    const artifactPath = await makeArtifactFile('');
    executePlaywrightTestMock.mockResolvedValue({
      success: false,
      error: 'fail',
      logs: [],
      artifacts: [{ name: 'trace', path: artifactPath, contentType: 'application/zip' }],
      duration_ms: 10,
    });
    fetchHandler = (url, init) => {
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 71, executionId: 504 }] }), {
          status: 200,
        });
      }
      if (url.includes('/api/agent/qa/artifacts')) {
        return new Response('down', { status: 500 });
      }
      if (url.includes('/api/agent/results')) {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        expect(body).toMatchObject({ status: 'FAILED', traceUrl: null });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 204 });
    };
    // Make the 500ms artifact-upload retry immediate.
    globalThis.setTimeout = ((cb: TimerHandler, _ms?: number, ...args: unknown[]) =>
      originalSetTimeout(cb, 0, ...args)) as typeof setTimeout;

    await handleQaJob(baseCfg, makeQaJob());

    const artifactCalls = fetchMock.mock.calls.filter((c) =>
      (typeof c[0] === 'string' ? c[0] : c[0].toString()).includes('/api/agent/qa/artifacts'),
    );
    expect(artifactCalls).toHaveLength(2);
  });

  test('createQaExecutions failure with playwright available is logged', async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = await makeBrowserDir(['chromium-headless-shell']);
    fetchHandler = (url) => {
      if (url.includes('/api/agent/qa/executions')) return new Response('db down', { status: 500 });
      return new Response(null, { status: 204 });
    };

    await handleQaJob(baseCfg, makeQaJob());

    expect(loggerCalls.error.some((m) => m.includes('create-executions failed'))).toBe(true);
    expect(executePlaywrightTestMock).not.toHaveBeenCalled();
  });

  test('missing execution id for a test logs a warning and skips the test', async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = await makeBrowserDir(['chromium-headless-shell']);
    fetchHandler = (url) => {
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 999, executionId: 505 }] }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    };

    await handleQaJob(baseCfg, makeQaJob({ tests: [{ id: 71, name: 'Login', script: 's' }] }));

    expect(loggerCalls.warn.some((m) => m.includes('no exec id for test 71'))).toBe(true);
    expect(executePlaywrightTestMock).not.toHaveBeenCalled();
  });
});

// ==================== isPlaywrightAvailable ====================

describe('isPlaywrightAvailable', () => {
  test('detects chromium directory under PLAYWRIGHT_BROWSERS_PATH', async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = await makeBrowserDir([
      'chromium-headless-shell',
      'firefox',
    ]);
    fetchHandler = (url) => {
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 1, executionId: 701 }] }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    };

    await handleQaJob(baseCfg, {
      jobId: 'qa-1',
      type: 'qa',
      executionId: 1,
      regionId: 1,
      projectId: 1,
      targetUrl: 'https://x',
      tests: [{ id: 1, name: 't', script: 's' }],
    });

    expect(executePlaywrightTestMock).toHaveBeenCalled();
  });

  test('falls back to default cache when env is unset', async () => {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    const home = await mkdtemp(join(tmpdir(), 'oo-agent-home-'));
    tempDirs.push(home);
    await mkdir(join(home, '.cache', 'ms-playwright', 'chromium-1234'), { recursive: true });
    process.env.HOME = home;
    fetchHandler = (url) => {
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 1, executionId: 702 }] }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    };

    await handleQaJob(baseCfg, {
      jobId: 'qa-2',
      type: 'qa',
      executionId: 1,
      regionId: 1,
      projectId: 1,
      targetUrl: 'https://x',
      tests: [{ id: 1, name: 't', script: 's' }],
    });

    expect(executePlaywrightTestMock).toHaveBeenCalled();
  });

  test('returns false when no chromium directory exists', async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = await makeBrowserDir(['firefox']);
    fetchHandler = (url) => {
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 1, executionId: 703 }] }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    };

    await handleQaJob(baseCfg, {
      jobId: 'qa-3',
      type: 'qa',
      executionId: 1,
      regionId: 1,
      projectId: 1,
      targetUrl: 'https://x',
      tests: [{ id: 1, name: 't', script: 's' }],
    });

    expect(executePlaywrightTestMock).not.toHaveBeenCalled();
  });

  test('caches the detection result', async () => {
    const browserDir = await makeBrowserDir(['chromium-1234']);
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserDir;
    fetchHandler = (url) => {
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 1, executionId: 704 }] }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    };

    await handleQaJob(baseCfg, {
      jobId: 'qa-4',
      type: 'qa',
      executionId: 1,
      regionId: 1,
      projectId: 1,
      targetUrl: 'https://x',
      tests: [{ id: 1, name: 't', script: 's' }],
    });

    // Remove the browser directory. A cached true result still runs tests;
    // an uncached probe would now see no chromium and skip them.
    await rm(join(browserDir, 'chromium-1234'), { recursive: true, force: true });
    executePlaywrightTestMock.mockClear();

    await handleQaJob(baseCfg, {
      jobId: 'qa-5',
      type: 'qa',
      executionId: 1,
      regionId: 1,
      projectId: 1,
      targetUrl: 'https://x',
      tests: [{ id: 1, name: 't2', script: 's' }],
    });

    expect(executePlaywrightTestMock).toHaveBeenCalled();
  });
});

// ==================== runAgent loop ====================

describe('runAgent', () => {
  test('logs startup and region info', async () => {
    await runAgentUntil(baseCfg, () => loggerCalls.info.length > 0, 100);

    expect(loggerCalls.info[0]).toContain('agent starting');
    expect(loggerCalls.info[0]).toContain(MASTER);
    expect(loggerCalls.info[0]).toContain('us-east');
  });

  test('emits a startup security warning when tlsInsecure is on', async () => {
    await runAgentUntil({ ...baseCfg, tlsInsecure: true }, () => loggerCalls.warn.length > 0, 100);

    expect(loggerCalls.warn.some((m) => m.includes('OO_AGENT_TLS_INSECURE is ON'))).toBe(true);
  });

  test('re-warns about tls insecure roughly hourly', async () => {
    let now = 1_000_000;
    const dateNowMock = mock(() => now);
    globalThis.Date.now = dateNowMock as typeof Date.now;
    try {
      fetchHandler = () => new Response(null, { status: 204 });
      const runPromise = runAgent({ ...baseCfg, tlsInsecure: true });
      await new Promise((r) => setTimeout(r, 10));
      expect(loggerCalls.warn.length).toBeGreaterThanOrEqual(1);

      now += 3_600_001;
      await new Promise((r) => setTimeout(r, 50));
      sigintHandler?.();
      await runPromise;

      expect(
        loggerCalls.warn.filter((m) => m.includes('OO_AGENT_TLS_INSECURE is still ON')).length,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      Date.now = originalDateNow;
    }
  });

  test('picks up a job, runs it, posts the result, and logs completion', async () => {
    let jobReturned = false;
    fetchHandler = (url) => {
      if (url.includes('/api/agent/jobs') && !jobReturned) {
        jobReturned = true;
        return new Response(
          JSON.stringify(
            makeJob({ type: 'url', monitor: { id: 1, url: 'https://run.test', timeoutMs: 1000 } }),
          ),
          { status: 200 },
        );
      }
      return new Response(null, { status: 204 });
    };

    await runAgentUntil(
      baseCfg,
      () => loggerCalls.info.some((m) => m.includes('agent reported')),
      500,
    );

    expect(loggerCalls.info.some((m) => m.includes('agent picked up exec=1 type=url'))).toBe(true);
    expect(loggerCalls.info.some((m) => m.includes('agent reported exec=1 status=SUCCESS'))).toBe(
      true,
    );
    expect(findFetchCall((u) => u.includes('/api/agent/results'))).toBeDefined();
  });

  test('handles qa jobs through handleQaJob and logs test count', async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH = await makeBrowserDir(['chromium-headless-shell']);
    fetchHandler = (url) => {
      if (url.includes('/api/agent/jobs')) {
        return new Response(
          JSON.stringify(
            makeJob({
              type: 'qa',
              projectId: 7,
              targetUrl: 'https://shop.test',
              tests: [{ id: 1, name: 't', script: 's' }],
              monitor: undefined,
            }),
          ),
          { status: 200 },
        );
      }
      if (url.includes('/api/agent/qa/executions')) {
        return new Response(JSON.stringify({ executions: [{ testId: 1, executionId: 601 }] }), {
          status: 200,
        });
      }
      return new Response(null, { status: 204 });
    };

    await runAgentUntil(
      baseCfg,
      () => loggerCalls.info.some((m) => m.includes('agent finished qa')),
      500,
    );

    expect(
      loggerCalls.info.some((m) => m.includes('agent finished qa job=') && m.includes('1 tests')),
    ).toBe(true);
  });

  test('backoff escalates on consecutive loop errors and resets after success', async () => {
    let failures = 0;
    fetchHandler = () => {
      failures++;
      if (failures <= 2) throw new Error(`poll ${failures}`);
      return new Response(null, { status: 204 });
    };
    globalThis.setTimeout = ((cb: TimerHandler, _ms?: number, ...args: unknown[]) =>
      originalSetTimeout(cb, 0, ...args)) as typeof setTimeout;

    await runAgentUntil(
      baseCfg,
      () => loggerCalls.error.length >= 2 && loggerCalls.error.every((m) => m.includes('retry in')),
      500,
    );

    const messages = loggerCalls.error.filter((m) => m.includes('retry in'));
    expect(messages[0]).toContain('retry in 1000ms');
    expect(messages[1]).toContain('retry in 2000ms');
  });

  test('SIGTERM handler exits cleanly', async () => {
    const runPromise = runAgent(baseCfg);
    await new Promise((r) => setTimeout(r, 10));
    sigtermHandler?.();
    await runPromise;

    expect(loggerCalls.info.some((m) => m.includes('agent loop exited cleanly'))).toBe(true);
  });

  test('SIGINT handler exits cleanly', async () => {
    const runPromise = runAgent(baseCfg);
    await new Promise((r) => setTimeout(r, 10));
    sigintHandler?.();
    await runPromise;

    expect(loggerCalls.info.some((m) => m.includes('agent loop exited cleanly'))).toBe(true);
  });
});
