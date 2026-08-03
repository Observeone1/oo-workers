import { urlMonitorRepo } from '../db/repositories/url-monitor.repo.ts';
import { apiCheckRepo } from '../db/repositories/api-check.repo.ts';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import { tcpMonitorRepo } from '../db/repositories/tcp-monitor.repo.ts';
import { udpMonitorRepo } from '../db/repositories/udp-monitor.repo.ts';
import { dbMonitorRepo } from '../db/repositories/db-monitor.repo.ts';
import { tlsMonitorRepo } from '../db/repositories/tls-monitor.repo.ts';
import {
  badPort,
  parseExpectCnRegex,
  validateApiAssertions,
  validatePayloadHex,
} from './monitor-route-validation.ts';
import type { MonitorRouteResult } from './monitor-route-types.ts';

async function updateUrlMonitor(
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
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

async function updateApiMonitor(
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
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
    rawAssertions.map((a: { type: string; operator: string; path?: string; value?: string }) => ({
      type: a.type,
      operator: a.operator,
      path: a.path ?? null,
      value: a.value ?? null,
    })),
  );
  return { status: 200, body: m };
}

async function updateTcpMonitor(
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
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

async function updateUdpMonitor(
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
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

async function updateDbMonitor(
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
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

async function updateTlsMonitor(
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
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

async function updateQaMonitor(
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
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

const UPDATE_BY_TYPE: Record<
  string,
  (id: number, body: Record<string, unknown>) => Promise<MonitorRouteResult>
> = {
  url: updateUrlMonitor,
  api: updateApiMonitor,
  tcp: updateTcpMonitor,
  udp: updateUdpMonitor,
  db: updateDbMonitor,
  tls: updateTlsMonitor,
  qa: updateQaMonitor,
};

export async function dispatchMonitorUpdate(
  type: string,
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
  const handler = UPDATE_BY_TYPE[type];
  if (!handler) return { status: 400, body: { error: 'bad type' } };
  return handler(id, body);
}
