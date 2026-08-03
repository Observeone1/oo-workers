/**
 * Type-dispatch helpers for /api/monitors/:type/:id routes.
 */
import { urlMonitorRepo } from '../db/repositories/url-monitor.repo.ts';
import { apiCheckRepo } from '../db/repositories/api-check.repo.ts';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import { tcpMonitorRepo } from '../db/repositories/tcp-monitor.repo.ts';
import { udpMonitorRepo } from '../db/repositories/udp-monitor.repo.ts';
import { dbMonitorRepo } from '../db/repositories/db-monitor.repo.ts';
import { tlsMonitorRepo } from '../db/repositories/tls-monitor.repo.ts';
import { heartbeatRepo } from '../db/repositories/heartbeat.repo.ts';
import { parseHexPayload } from '../services/udp-probe.ts';
import type { RouteDeps } from './types.ts';

export type MonitorRouteResult =
  | { status: 200; body: unknown }
  | { status: 400; body: { error: string } }
  | { status: 404; body: { error: string } };

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

export function badPort(port: number): boolean {
  return !Number.isInteger(port) || port < 1 || port > 65535;
}

export function validatePayloadHex(hex: unknown): string | null {
  if (!hex) return null;
  try {
    parseHexPayload(hex as string);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid payloadHex';
  }
}

export function validateApiAssertions(
  rawAssertions: unknown,
  opts?: { shortErrors?: boolean },
): string | null {
  if (!Array.isArray(rawAssertions)) return 'assertions must be an array';
  const short = opts?.shortErrors === true;
  for (let i = 0; i < rawAssertions.length; i++) {
    const a = rawAssertions[i] as { type?: unknown; operator?: unknown };
    if (!a || typeof a !== 'object') return `assertions[${i}] must be an object`;
    if (typeof a.type !== 'string' || !VALID_ASSERTION_TYPES.has(a.type)) {
      return short
        ? `assertions[${i}].type invalid`
        : `assertions[${i}].type must be one of: ${[...VALID_ASSERTION_TYPES].join(', ')}`;
    }
    if (typeof a.operator !== 'string' || !VALID_ASSERTION_OPERATORS.has(a.operator)) {
      return short
        ? `assertions[${i}].operator invalid`
        : `assertions[${i}].operator must be one of: ${[...VALID_ASSERTION_OPERATORS].join(', ')}`;
    }
  }
  return null;
}

function parseExpectCnRegex(raw: unknown): { value: string | null } | { error: string } {
  if (raw == null || String(raw).length === 0) return { value: null };
  const s = String(raw);
  if (s.length > 200) return { error: 'expectCnRegex too long (max 200 chars)' };
  if (/\([^()]*[+*][^()]*\)[+*]/.test(s)) {
    return { error: 'expectCnRegex has a trivially-nested quantifier' };
  }
  try {
    new RegExp(s);
  } catch (e) {
    return { error: `expectCnRegex invalid: ${e instanceof Error ? e.message : e}` };
  }
  return { value: s };
}

export async function getMonitorDetail(type: string, id: number): Promise<MonitorRouteResult> {
  switch (type) {
    case 'url': {
      const [m] = await urlMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const [assertions, runs] = await Promise.all([
        urlMonitorRepo.findAssertionsByMonitorId(id),
        urlMonitorRepo.findExecutionsByMonitorId(id),
      ]);
      return { status: 200, body: { monitor: { ...m, type: 'url' }, assertions, runs } };
    }
    case 'api': {
      const [m] = await apiCheckRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const [assertions, runs] = await Promise.all([
        apiCheckRepo.findAssertionsByCheckId(id),
        apiCheckRepo.findExecutionsByCheckId(id),
      ]);
      return { status: 200, body: { monitor: { ...m, type: 'api' }, assertions, runs } };
    }
    case 'qa': {
      const [m] = await qaProjectRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const [tests, runs] = await Promise.all([
        qaProjectRepo.findTestsByProjectId(id),
        qaProjectRepo.findExecutionsByProjectId(id),
      ]);
      return { status: 200, body: { monitor: { ...m, type: 'qa' }, tests, runs } };
    }
    case 'tcp': {
      const [m] = await tcpMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const runs = await tcpMonitorRepo.findExecutionsByMonitorId(id);
      return {
        status: 200,
        body: {
          monitor: { ...m, type: 'tcp' },
          runs: runs.map((r) => ({ ...r, responseTimeMs: r.latencyMs })),
        },
      };
    }
    case 'udp': {
      const [m] = await udpMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const runs = await udpMonitorRepo.findExecutionsByMonitorId(id);
      return {
        status: 200,
        body: {
          monitor: { ...m, type: 'udp' },
          runs: runs.map((r) => ({ ...r, responseTimeMs: r.latencyMs })),
        },
      };
    }
    case 'db': {
      const [m] = await dbMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const runs = await dbMonitorRepo.findExecutionsByMonitorId(id);
      return {
        status: 200,
        body: {
          monitor: { ...m, type: 'db' },
          runs: runs.map((r) => ({ ...r, responseTimeMs: r.latencyMs })),
        },
      };
    }
    case 'tls': {
      const [m] = await tlsMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const runs = await tlsMonitorRepo.findExecutionsByMonitorId(id);
      return {
        status: 200,
        body: {
          monitor: { ...m, type: 'tls' },
          runs: runs.map((r) => ({ ...r, responseTimeMs: r.latencyMs })),
        },
      };
    }
    case 'heartbeat': {
      const [m] = await heartbeatRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: { monitor: { ...m, type: 'heartbeat' }, runs: [] } };
    }
    default:
      return { status: 400, body: { error: 'bad type' } };
  }
}

export async function updateMonitorByType(
  type: string,
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
  switch (type) {
    case 'url': {
      if (!body.name || !body.url) return { status: 400, body: { error: 'name + url required' } };
      const [m] = await urlMonitorRepo.update(id, {
        name: body.name as string,
        url: body.url as string,
        intervalSeconds: (body.intervalSeconds as number | undefined) ?? 60,
      });
      if (!m) return { status: 404, body: { error: 'not found' } };
      if (Array.isArray(body.assertions)) {
        await urlMonitorRepo.replaceAssertions(
          id,
          (body.assertions as Array<{ operator: string; statusCode: number }>).map((a) => ({
            operator: a.operator,
            statusCode: Number(a.statusCode),
          })),
        );
      }
      return { status: 200, body: m };
    }
    case 'api': {
      if (!body.name || !body.url) return { status: 400, body: { error: 'name + url required' } };
      const rawAssertions = Array.isArray(body.assertions) ? body.assertions : [];
      const assertErr = validateApiAssertions(rawAssertions, { shortErrors: true });
      if (assertErr) return { status: 400, body: { error: assertErr } };
      const [m] = await apiCheckRepo.update(id, {
        name: body.name as string,
        url: body.url as string,
        method: (body.method as string | undefined) ?? 'GET',
        intervalSeconds: (body.intervalSeconds as number | undefined) ?? 60,
      });
      if (!m) return { status: 404, body: { error: 'not found' } };
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
      return { status: 200, body: m };
    }
    case 'tcp': {
      const port = Number(body.port);
      if (!body.name || !body.host || badPort(port)) {
        return { status: 400, body: { error: 'name + host + port (1-65535) required' } };
      }
      const hexErr = validatePayloadHex(body.payloadHex);
      if (hexErr) return { status: 400, body: { error: hexErr } };
      const [m] = await tcpMonitorRepo.update(id, {
        name: body.name as string,
        host: body.host as string,
        port,
        payloadHex: (body.payloadHex as string | null | undefined) ?? null,
        expectBanner: (body.expectBanner as string | null | undefined) ?? null,
        intervalSeconds: (body.intervalSeconds as number | undefined) ?? 60,
      });
      if (!m) return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: m };
    }
    case 'udp': {
      const port = Number(body.port);
      if (!body.name || !body.host || badPort(port)) {
        return { status: 400, body: { error: 'name + host + port (1-65535) required' } };
      }
      const hexErr = validatePayloadHex(body.payloadHex);
      if (hexErr) return { status: 400, body: { error: hexErr } };
      const [m] = await udpMonitorRepo.update(id, {
        name: body.name as string,
        host: body.host as string,
        port,
        payloadHex: (body.payloadHex as string | null | undefined) ?? null,
        expectResponse: body.expectResponse === true,
        intervalSeconds: (body.intervalSeconds as number | undefined) ?? 60,
      });
      if (!m) return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: m };
    }

    case 'db': {
      const port = Number(body.port);
      const protocol = body.protocol;
      if (!body.name || !body.host || badPort(port)) {
        return { status: 400, body: { error: 'name + host + port required' } };
      }
      if (protocol !== 'postgres' && protocol !== 'mysql' && protocol !== 'redis') {
        return { status: 400, body: { error: 'protocol must be postgres, mysql, or redis' } };
      }
      const [m] = await dbMonitorRepo.update(id, {
        name: body.name as string,
        host: body.host as string,
        port,
        protocol: protocol as string,
        tls: body.tls === true,
        intervalSeconds: (body.intervalSeconds as number | undefined) ?? 60,
      });
      if (!m) return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: m };
    }
    case 'tls': {
      const port = body.port == null ? 443 : Number(body.port);
      if (!body.name || !body.host || badPort(port)) {
        return { status: 400, body: { error: 'name + host required' } };
      }
      const warnDays = body.warnDays == null ? 30 : Number(body.warnDays);
      if (!Number.isInteger(warnDays) || warnDays < 0) {
        return { status: 400, body: { error: 'warnDays must be a non-negative integer' } };
      }
      const cnParsed = parseExpectCnRegex(body.expectCnRegex);
      if ('error' in cnParsed) return { status: 400, body: { error: cnParsed.error } };
      const [m] = await tlsMonitorRepo.update(id, {
        name: body.name as string,
        host: body.host as string,
        port,
        servername: (body.servername as string | null | undefined) || null,
        warnDays,
        intervalSeconds: (body.intervalSeconds as number | undefined) ?? 60,
        verifyChain: body.verifyChain === true,
        verifyHostname: body.verifyHostname === true,
        expectCnRegex: cnParsed.value,
      });
      if (!m) return { status: 404, body: { error: 'not found' } };
      return { status: 200, body: m };
    }
    case 'qa': {
      if (!body.name || !body.targetUrl) {
        return { status: 400, body: { error: 'name + targetUrl required' } };
      }
      const [m] = await qaProjectRepo.update(id, {
        name: body.name as string,
        targetUrl: body.targetUrl as string,
        intervalSeconds: (body.intervalSeconds as number | undefined) ?? 300,
      });
      if (!m) return { status: 404, body: { error: 'not found' } };
      if (typeof body.script === 'string') {
        await qaProjectRepo.updateFirstTestScript(id, body.script);
      }
      return { status: 200, body: m };
    }
    default:
      return { status: 400, body: { error: 'bad type' } };
  }
}

export async function runMonitorNow(
  type: string,
  id: number,
  deps: Pick<RouteDeps, 'urlQ' | 'apiQ' | 'qaQ' | 'tcpQ' | 'udpQ' | 'dbQ' | 'tlsQ'>,
): Promise<MonitorRouteResult> {
  const { urlQ, apiQ, qaQ, tcpQ, udpQ, dbQ, tlsQ } = deps;
  switch (type) {
    case 'url': {
      const [m] = await urlMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const assertions = await urlMonitorRepo.findAssertionsByMonitorId(id);
      const [exec] = await urlMonitorRepo.createExecution(id, 'PENDING');
      await urlQ.add('check', {
        executionId: exec.id,
        monitor: { id: m.id, url: m.url, timeoutMs: m.timeoutMs },
        assertions,
      });
      return { status: 200, body: { executionId: exec.id } };
    }
    case 'api': {
      const [m] = await apiCheckRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const assertions = await apiCheckRepo.findAssertionsByCheckId(id);
      const [exec] = await apiCheckRepo.createExecution(id, 'PENDING');
      await apiQ.add('check', { executionId: exec.id, apiCheck: m, assertions });
      return { status: 200, body: { executionId: exec.id } };
    }
    case 'qa': {
      const [m] = await qaProjectRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
      const tests = await qaProjectRepo.findTestsByProjectId(id, { includeScript: true });
      if (tests.length === 0) return { status: 400, body: { error: 'no tests on this project' } };
      await qaQ.add('run', {
        type: 'qa-project-run',
        projectId: m.id,
        targetUrl: m.targetUrl,
        credentials: m.credentials ?? undefined,
        config: m.config ?? {},
        tests,
        triggeredAt: new Date().toISOString(),
      });
      return { status: 200, body: { ok: true } };
    }
    case 'tcp': {
      const [m] = await tcpMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
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
      return { status: 200, body: { executionId: exec.id } };
    }
    case 'udp': {
      const [m] = await udpMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
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
      return { status: 200, body: { executionId: exec.id } };
    }
    case 'db': {
      const [m] = await dbMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
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
      return { status: 200, body: { executionId: exec.id } };
    }
    case 'tls': {
      const [m] = await tlsMonitorRepo.findById(id);
      if (!m) return { status: 404, body: { error: 'not found' } };
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
      return { status: 200, body: { executionId: exec.id } };
    }
    default:
      return { status: 400, body: { error: 'bad type' } };
  }
}
