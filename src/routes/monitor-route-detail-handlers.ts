import { urlMonitorRepo } from '../db/repositories/url-monitor.repo.ts';
import { apiCheckRepo } from '../db/repositories/api-check.repo.ts';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import { tcpMonitorRepo } from '../db/repositories/tcp-monitor.repo.ts';
import { udpMonitorRepo } from '../db/repositories/udp-monitor.repo.ts';
import { dbMonitorRepo } from '../db/repositories/db-monitor.repo.ts';
import { tlsMonitorRepo } from '../db/repositories/tls-monitor.repo.ts';
import { heartbeatRepo } from '../db/repositories/heartbeat.repo.ts';
import type { MonitorRouteResult } from './monitor-route-types.ts';

type LatencyRepo = {
  findById: (id: number) => Promise<unknown[]>;
  findExecutionsByMonitorId: (id: number) => Promise<Array<{ latencyMs: number | null }>>;
};

const LATENCY_REPOS: Record<'tcp' | 'udp' | 'db' | 'tls', LatencyRepo> = {
  tcp: tcpMonitorRepo,
  udp: udpMonitorRepo,
  db: dbMonitorRepo,
  tls: tlsMonitorRepo,
};

function mapLatencyRuns(runs: Array<{ latencyMs: number | null }>) {
  return runs.map((r) => ({ ...r, responseTimeMs: r.latencyMs }));
}

async function detailUrl(id: number): Promise<MonitorRouteResult> {
  const [m] = await urlMonitorRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const [assertions, runs] = await Promise.all([
    urlMonitorRepo.findAssertionsByMonitorId(id),
    urlMonitorRepo.findExecutionsByMonitorId(id),
  ]);
  return { status: 200, body: { monitor: { ...m, type: 'url' }, assertions, runs } };
}

async function detailApi(id: number): Promise<MonitorRouteResult> {
  const [m] = await apiCheckRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const [assertions, runs] = await Promise.all([
    apiCheckRepo.findAssertionsByCheckId(id),
    apiCheckRepo.findExecutionsByCheckId(id),
  ]);
  return { status: 200, body: { monitor: { ...m, type: 'api' }, assertions, runs } };
}

async function detailQa(id: number): Promise<MonitorRouteResult> {
  const [m] = await qaProjectRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const [tests, runs] = await Promise.all([
    qaProjectRepo.findTestsByProjectId(id),
    qaProjectRepo.findExecutionsByProjectId(id),
  ]);
  return { status: 200, body: { monitor: { ...m, type: 'qa' }, tests, runs } };
}

async function detailLatency(
  type: 'tcp' | 'udp' | 'db' | 'tls',
  id: number,
): Promise<MonitorRouteResult> {
  const repo = LATENCY_REPOS[type];
  const [m] = await repo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  const runs = await repo.findExecutionsByMonitorId(id);
  return { status: 200, body: { monitor: { ...m, type }, runs: mapLatencyRuns(runs) } };
}

async function detailHeartbeat(id: number): Promise<MonitorRouteResult> {
  const [m] = await heartbeatRepo.findById(id);
  if (!m) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: { monitor: { ...m, type: 'heartbeat' }, runs: [] } };
}

const DETAIL_BY_TYPE: Record<string, (id: number) => Promise<MonitorRouteResult>> = {
  url: detailUrl,
  api: detailApi,
  qa: detailQa,
  tcp: (id) => detailLatency('tcp', id),
  udp: (id) => detailLatency('udp', id),
  db: (id) => detailLatency('db', id),
  tls: (id) => detailLatency('tls', id),
  heartbeat: detailHeartbeat,
};

export async function dispatchMonitorDetail(type: string, id: number): Promise<MonitorRouteResult> {
  const handler = DETAIL_BY_TYPE[type];
  if (!handler) return { status: 400, body: { error: 'bad type' } };
  return handler(id);
}
