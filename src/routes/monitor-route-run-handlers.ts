import { urlMonitorRepo } from '../db/repositories/url-monitor.repo.ts';
import { apiCheckRepo } from '../db/repositories/api-check.repo.ts';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import { tcpMonitorRepo } from '../db/repositories/tcp-monitor.repo.ts';
import { udpMonitorRepo } from '../db/repositories/udp-monitor.repo.ts';
import { dbMonitorRepo } from '../db/repositories/db-monitor.repo.ts';
import { tlsMonitorRepo } from '../db/repositories/tls-monitor.repo.ts';
import type { RouteDeps } from './types.ts';
import type { MonitorRouteResult } from './monitor-route-types.ts';

type RunDeps = Pick<RouteDeps, 'urlQ' | 'apiQ' | 'qaQ' | 'tcpQ' | 'udpQ' | 'dbQ' | 'tlsQ'>;

async function runUrlMonitor(id: number, deps: RunDeps): Promise<MonitorRouteResult> {
  const [m] = await urlMonitorRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const assertions = await urlMonitorRepo.findAssertionsByMonitorId(id);
  const [exec] = await urlMonitorRepo.createExecution(id, 'PENDING');
  await deps.urlQ.add('check', {
    executionId: exec.id,
    monitor: { id: m.id, url: m.url, timeoutMs: m.timeoutMs },
    assertions,
  });
  return { status: 200, body: { executionId: exec.id } };
}

async function runApiMonitor(id: number, deps: RunDeps): Promise<MonitorRouteResult> {
  const [m] = await apiCheckRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const assertions = await apiCheckRepo.findAssertionsByCheckId(id);
  const [exec] = await apiCheckRepo.createExecution(id, 'PENDING');
  await deps.apiQ.add('check', { executionId: exec.id, apiCheck: m, assertions });
  return { status: 200, body: { executionId: exec.id } };
}

async function runQaMonitor(id: number, deps: RunDeps): Promise<MonitorRouteResult> {
  const [m] = await qaProjectRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const tests = await qaProjectRepo.findTestsByProjectId(id, { includeScript: true });
  if (tests.length === 0) return { status: 400, body: { error: 'no tests on this project' } };
  await deps.qaQ.add('run', {
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

async function runTcpMonitor(id: number, deps: RunDeps): Promise<MonitorRouteResult> {
  const [m] = await tcpMonitorRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const [exec] = await tcpMonitorRepo.createExecution(id, 'PENDING');
  await deps.tcpQ.add('check', {
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

async function runUdpMonitor(id: number, deps: RunDeps): Promise<MonitorRouteResult> {
  const [m] = await udpMonitorRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const [exec] = await udpMonitorRepo.createExecution(id, 'PENDING');
  await deps.udpQ.add('check', {
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

async function runDbMonitor(id: number, deps: RunDeps): Promise<MonitorRouteResult> {
  const [m] = await dbMonitorRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const [exec] = await dbMonitorRepo.createExecution(id, 'PENDING');
  await deps.dbQ.add('check', {
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

async function runTlsMonitor(id: number, deps: RunDeps): Promise<MonitorRouteResult> {
  const [m] = await tlsMonitorRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const [exec] = await tlsMonitorRepo.createExecution(id, 'PENDING');
  await deps.tlsQ.add('check', {
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

const RUN_BY_TYPE: Record<string, (id: number, deps: RunDeps) => Promise<MonitorRouteResult>> = {
  url: runUrlMonitor,
  api: runApiMonitor,
  qa: runQaMonitor,
  tcp: runTcpMonitor,
  udp: runUdpMonitor,
  db: runDbMonitor,
  tls: runTlsMonitor,
};

export async function dispatchMonitorRun(
  type: string,
  id: number,
  deps: RunDeps,
): Promise<MonitorRouteResult> {
  const handler = RUN_BY_TYPE[type];
  if (!handler) return { status: 400, body: { error: 'bad type' } };
  return handler(id, deps);
}
