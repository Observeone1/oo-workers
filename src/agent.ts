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
import { tlsProbe } from './services/tls-probe.ts';
import { evaluateUrlMonitorAssertions } from './services/url-assertion.ts';
import { evaluateAssertions } from './services/api-assertion.ts';
import { classifyFetchError } from './utils/fetch-errors.ts';
import { logger } from './utils/logger.ts';
import { packageVersion } from './utils/version.ts';
import type { AgentResultBody } from './services/agent-dispatch.ts';

export interface AgentConfig {
  masterUrl: string;
  agentKey: string;
  regionSlug: string;
  /** Long-poll wait in seconds (master clamps to [1,60]). Default 30. */
  pollWaitSec: number;
  /**
   * Skip TLS verification for the agent→master connection ONLY (the two
   * fetches in this file). Probe targets are unaffected — their TLS is
   * still validated. For self-signed / internal-CA masters. NOT low risk
   * (an attacker on the agent↔master path can suppress FAILED results,
   * inject false SUCCESS, or steal the agent key) — see docs.
   */
  tlsInsecure: boolean;
}

// Bun's fetch accepts a per-request `tls` option; the DOM fetch lib
// typings don't. Scoped cast — applied to the master fetches only.
function masterFetchInit(cfg: AgentConfig, init: RequestInit): RequestInit {
  if (!cfg.tlsInsecure) return init;
  return { ...init, tls: { rejectUnauthorized: false } } as RequestInit & {
    tls: { rejectUnauthorized: boolean };
  };
}

interface JobPayload {
  jobId: string;
  type: 'url' | 'api' | 'tcp' | 'udp' | 'qa' | 'db' | 'tls';
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
    expectBanner?: string | null;
    protocol?: string;
    tls?: boolean;
    servername?: string | null;
    warnDays?: number;
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

// Exported for scripts/agent-tls-test.ts — the OO_AGENT_TLS_INSECURE
// gate. This is the single agent→master read; if its TLS handling is
// right, postResult (same masterFetchInit) is right by construction.
export async function pollJob(cfg: AgentConfig): Promise<JobPayload | null> {
  const res = await fetch(
    `${cfg.masterUrl}/api/agent/jobs?wait=${cfg.pollWaitSec}`,
    masterFetchInit(cfg, {
      headers: {
        Authorization: `Bearer ${cfg.agentKey}`,
        // Force a fresh TCP connection per poll. Bun reuses sockets via its
        // connection pool by default; an idle keep-alive connection can be
        // closed by the master between polls and the next reuse fails with
        // "socket connection was closed unexpectedly". Long-poll is naturally
        // low-frequency so we don't need the pool's throughput win.
        Connection: 'close',
        // Master caches this on the regions row so /api/regions can flag
        // version skew (different agent vs master versions in the fleet).
        'X-Agent-Version': packageVersion(),
      },
      // Slightly longer than server-side wait so the agent doesn't time out
      // before master returns 204.
      signal: AbortSignal.timeout((cfg.pollWaitSec + 5) * 1000),
    }),
  );
  if (res.status === 204) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`master returned ${res.status} on /api/agent/jobs: ${text}`);
  }
  return (await res.json()) as JobPayload;
}

async function postResult(cfg: AgentConfig, body: AgentResultBody): Promise<void> {
  const res = await fetch(
    `${cfg.masterUrl}/api/agent/results`,
    masterFetchInit(cfg, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.agentKey}`,
        'content-type': 'application/json',
        Connection: 'close',
        'X-Agent-Version': packageVersion(),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }),
  );
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
  let payload: Buffer | null;
  try {
    payload = parseHexPayload(m.payloadHex);
  } catch (err) {
    return {
      type: 'tcp',
      executionId: job.executionId,
      status: 'FAILED',
      errorMessage: err instanceof Error ? err.message : 'invalid payload_hex',
    };
  }
  const result = await tcpProbe({
    host: m.host!,
    port: m.port!,
    timeoutMs,
    payload,
    expectBanner: m.expectBanner ?? null,
  });
  return {
    type: 'tcp',
    executionId: job.executionId,
    status: result.ok ? 'SUCCESS' : 'FAILED',
    latencyMs: result.latencyMs,
    banner: result.banner ?? null,
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

async function probeTls(job: JobPayload): Promise<AgentResultBody> {
  const m = job.monitor!;
  const timeoutMs = m.timeoutMs || DEFAULTS.TCP_TIMEOUT_MS;
  const result = await tlsProbe({
    host: m.host!,
    port: m.port!,
    timeoutMs,
    warnDays: m.warnDays ?? 30,
    servername: m.servername ?? null,
  });
  return {
    type: 'tls',
    executionId: job.executionId,
    status: result.ok ? 'SUCCESS' : 'FAILED',
    latencyMs: result.latencyMs,
    daysRemaining: result.daysRemaining ?? null,
    validTo: result.validTo ? result.validTo.toISOString() : null,
    certSummary: result.certSummary ?? null,
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
    case 'tls':
      return probeTls(job);
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
  if (cfg.tlsInsecure) {
    logger.warn(
      '\n⚠ SECURITY: OO_AGENT_TLS_INSECURE is ON — TLS verification is\n' +
        '  DISABLED for the agent→master connection. An attacker on the\n' +
        '  agent↔master network path can read/modify this traffic: suppress\n' +
        '  FAILED results, inject false SUCCESS, or steal the agent key on\n' +
        '  the first poll. This is NOT "low risk" — it only narrows the\n' +
        '  surface vs a global TLS bypass (probe targets stay validated).\n' +
        '  Use a real cert (Let’s Encrypt) or a Tailscale/Wireguard tunnel\n' +
        '  instead wherever possible. Unset OO_AGENT_TLS_INSECURE to fix.',
    );
  }
  // Drift defence: re-warn ~hourly so a "just testing" flag set months
  // ago doesn't stay silently on. Startup already warned → first repeat
  // is ~1h in.
  let lastInsecureWarn = Date.now();
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
      if (cfg.tlsInsecure && Date.now() - lastInsecureWarn > 3_600_000) {
        logger.warn(
          '⚠ SECURITY: OO_AGENT_TLS_INSECURE is still ON — agent→master ' +
            'TLS verification remains disabled. Unset it once you have a ' +
            'real cert / tunnel.',
        );
        lastInsecureWarn = Date.now();
      }
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
