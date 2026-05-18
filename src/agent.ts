/**
 * Multi-region agent — pulls jobs from a master via HTTP long-poll, runs
 * the probe locally using the same pure services as master in-process
 * workers, and POSTs the result back. No DB, no Redis, no scheduler.
 *
 * The agent only needs three environment variables:
 *   OO_MASTER_URL    https://master.example.com (or http://localhost:3010)
 *   OO_AGENT_KEY     oo_… (scope=agent, bound to a region row on master)
 *   OO_REGION_SLUG   us-east (matches the slug used in create-region.ts)
 *
 * Status conventions match master processors (SUCCESS / FAILED) so the
 * dashboard renders multi-region runs identically to single-node ones.
 *
 * QA (Playwright) jobs are not yet supported on agents — the agent
 * reports them as ERROR with a clear message so the exec row doesn't
 * sit PENDING and the operator sees the gap in the UI.
 */

import { DEFAULTS } from './constants.ts';
import { tcpProbe } from './services/tcp-probe.ts';
import { parseHexPayload, udpProbe } from './services/udp-probe.ts';
import { dbProbe, type DbProtocol } from './services/db-probe.ts';
import { evaluateUrlMonitorAssertions } from './services/url-assertion.ts';
import { evaluateAssertions } from './services/api-assertion.ts';
import { classifyFetchError } from './utils/fetch-errors.ts';
import { logger } from './utils/logger.ts';
import type { AgentResultBody } from './services/agent-dispatch.ts';

export interface AgentConfig {
  masterUrl: string;
  agentKey: string;
  regionSlug: string;
  /** Long-poll wait in seconds (master clamps to [1,60]). Default 30. */
  pollWaitSec: number;
}

interface JobPayload {
  jobId: string;
  type: 'url' | 'api' | 'tcp' | 'udp' | 'qa' | 'db';
  executionId: number;
  regionId: number;
  monitor?: {
    id: number;
    url?: string;
    host?: string;
    port?: number;
    timeoutMs: number;
    payloadHex?: string | null;
    expectResponse?: boolean;
    protocol?: string;
    tls?: boolean;
  };
  apiCheck?: {
    id: number;
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: string | null;
    timeoutMs: number;
  };
  assertions?: unknown[];
}

async function pollJob(cfg: AgentConfig): Promise<JobPayload | null> {
  const res = await fetch(`${cfg.masterUrl}/api/agent/jobs?wait=${cfg.pollWaitSec}`, {
    headers: {
      Authorization: `Bearer ${cfg.agentKey}`,
      // Force a fresh TCP connection per poll. Bun reuses sockets via its
      // connection pool by default; an idle keep-alive connection can be
      // closed by the master between polls and the next reuse fails with
      // "socket connection was closed unexpectedly". Long-poll is naturally
      // low-frequency so we don't need the pool's throughput win.
      Connection: 'close',
    },
    // Slightly longer than server-side wait so the agent doesn't time out
    // before master returns 204.
    signal: AbortSignal.timeout((cfg.pollWaitSec + 5) * 1000),
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`master returned ${res.status} on /api/agent/jobs: ${text}`);
  }
  return (await res.json()) as JobPayload;
}

async function postResult(cfg: AgentConfig, body: AgentResultBody): Promise<void> {
  const res = await fetch(`${cfg.masterUrl}/api/agent/results`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.agentKey}`,
      'content-type': 'application/json',
      Connection: 'close',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`master returned ${res.status} on /api/agent/results: ${text}`);
  }
}

// ---- per-type probe functions (mirror processors minus DB writes) ----

async function probeUrl(job: JobPayload): Promise<AgentResultBody> {
  const url = job.monitor!.url!;
  const timeoutMs = job.monitor!.timeoutMs || DEFAULTS.URL_TIMEOUT_MS;
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - start;
    const assertionResults = evaluateUrlMonitorAssertions(
      (job.assertions ?? []) as Parameters<typeof evaluateUrlMonitorAssertions>[0],
      res.status,
    );
    const allPassed = assertionResults.every((r: { passed: boolean }) => r.passed);
    return {
      type: 'url',
      executionId: job.executionId,
      status: allPassed ? 'SUCCESS' : 'FAILED',
      statusCode: res.status,
      latencyMs,
      assertionResults,
      errorMessage: allPassed ? null : 'One or more assertions failed',
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const msg = classifyFetchError(err, url, timeoutMs);
    return {
      type: 'url',
      executionId: job.executionId,
      status: 'FAILED',
      latencyMs,
      errorMessage: msg,
    };
  }
}

async function probeApi(job: JobPayload): Promise<AgentResultBody> {
  const api = job.apiCheck!;
  const timeoutMs = api.timeoutMs || DEFAULTS.API_TIMEOUT_MS;
  const headers: Record<string, string> = { ...(api.headers ?? {}) };
  const requestInit: RequestInit = { method: api.method || 'GET', headers };
  if (api.body && ['POST', 'PUT', 'PATCH'].includes(api.method)) {
    requestInit.body = typeof api.body === 'string' ? api.body : JSON.stringify(api.body);
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  requestInit.signal = controller.signal;

  const start = Date.now();
  try {
    const res = await fetch(api.url, requestInit);
    clearTimeout(timeout);
    const responseTimeMs = Date.now() - start;
    const body = await res.text();
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const assertionResults = await evaluateAssertions((job.assertions ?? []) as never, {
      status: res.status,
      responseTime: responseTimeMs,
      body,
      headers: responseHeaders,
    });
    const allPassed =
      assertionResults.length === 0 || assertionResults.every((r: { passed: boolean }) => r.passed);
    return {
      type: 'api',
      executionId: job.executionId,
      status: allPassed ? 'SUCCESS' : 'FAILED',
      responseStatus: res.status,
      responseTimeMs,
      responseBody: body.substring(0, DEFAULTS.RESPONSE_BODY_TRUNCATE_CHARS),
      responseHeaders,
      assertionResults,
      errorMessage: allPassed ? null : 'One or more assertions failed',
    };
  } catch (err) {
    clearTimeout(timeout);
    const msg = classifyFetchError(err, api.url, timeoutMs);
    return {
      type: 'api',
      executionId: job.executionId,
      status: 'FAILED',
      errorMessage: msg,
    };
  }
}

async function probeTcp(job: JobPayload): Promise<AgentResultBody> {
  const m = job.monitor!;
  const timeoutMs = m.timeoutMs || DEFAULTS.TCP_TIMEOUT_MS;
  const result = await tcpProbe(m.host!, m.port!, timeoutMs);
  return {
    type: 'tcp',
    executionId: job.executionId,
    status: result.ok ? 'SUCCESS' : 'FAILED',
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage ?? null,
  };
}

async function probeUdp(job: JobPayload): Promise<AgentResultBody> {
  const m = job.monitor!;
  const timeoutMs = m.timeoutMs || DEFAULTS.UDP_TIMEOUT_MS;
  let payload: Buffer | null;
  try {
    payload = parseHexPayload(m.payloadHex);
  } catch (err) {
    return {
      type: 'udp',
      executionId: job.executionId,
      status: 'FAILED',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
  const result = await udpProbe({
    host: m.host!,
    port: m.port!,
    payload,
    expectResponse: !!m.expectResponse,
    timeoutMs,
  });
  return {
    type: 'udp',
    executionId: job.executionId,
    status: result.ok ? 'SUCCESS' : 'FAILED',
    latencyMs: result.latencyMs,
    responseBytes: result.responseBytes ?? null,
    errorMessage: result.errorMessage ?? null,
  };
}

async function probeDb(job: JobPayload): Promise<AgentResultBody> {
  const m = job.monitor!;
  const timeoutMs = m.timeoutMs || DEFAULTS.DB_TIMEOUT_MS;
  const result = await dbProbe({
    host: m.host!,
    port: m.port!,
    protocol: m.protocol as DbProtocol,
    tls: m.tls,
    timeoutMs,
  });
  return {
    type: 'db',
    executionId: job.executionId,
    status: result.ok ? 'SUCCESS' : 'FAILED',
    latencyMs: result.latencyMs,
    errorMessage: result.errorMessage ?? null,
  };
}

async function runProbe(job: JobPayload): Promise<AgentResultBody> {
  switch (job.type) {
    case 'url':
      return probeUrl(job);
    case 'api':
      return probeApi(job);
    case 'tcp':
      return probeTcp(job);
    case 'udp':
      return probeUdp(job);
    case 'db':
      return probeDb(job);
    case 'qa':
      return {
        type: 'qa',
        executionId: job.executionId,
        status: 'ERROR',
        errorMessage:
          "QA (browser) monitors are not yet supported on agents. To run them from master only, delete the matching row from monitor_regions where monitor_type='qa'.",
      };
    default: {
      const _exhaustive: never = job.type;
      throw new Error(`unhandled monitor type: ${_exhaustive}`);
    }
  }
}

export async function runAgent(cfg: AgentConfig): Promise<void> {
  logger.info(
    `🛰  agent starting: master=${cfg.masterUrl} region=${cfg.regionSlug} wait=${cfg.pollWaitSec}s`,
  );
  let backoffMs = 1000;

  // Cleanly handle shutdown — let the in-flight probe (if any) finish before exiting.
  let running = true;
  const shutdown = (sig: string) => {
    logger.info(`agent received ${sig}, stopping after current job`);
    running = false;
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  while (running) {
    try {
      const job = await pollJob(cfg);
      backoffMs = 1000;
      if (!job) continue;
      logger.info(`agent picked up exec=${job.executionId} type=${job.type} (jobId=${job.jobId})`);
      const result = await runProbe(job);
      await postResult(cfg, result);
      logger.info(
        `agent reported exec=${job.executionId} status=${result.status}${
          result.latencyMs !== undefined && result.latencyMs !== null
            ? ` (${result.latencyMs}ms)`
            : ''
        }`,
      );
    } catch (err) {
      logger.error(
        `agent loop error: ${err instanceof Error ? err.message : String(err)}; retry in ${
          backoffMs
        }ms`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
  logger.info('agent loop exited cleanly');
}
