/**
 * Type-dispatch helpers for /api/monitors/:type/:id routes.
 */
import type { RouteDeps } from './types.ts';
import { dispatchMonitorDetail } from './monitor-route-detail-handlers.ts';
import { dispatchMonitorUpdate } from './monitor-route-update-handlers.ts';
import { dispatchMonitorRun } from './monitor-route-run-handlers.ts';
import type { MonitorRouteResult } from './monitor-route-types.ts';

export type { MonitorRouteResult } from './monitor-route-types.ts';
export { badPort, validateApiAssertions, validatePayloadHex } from './monitor-route-validation.ts';

export async function getMonitorDetail(type: string, id: number): Promise<MonitorRouteResult> {
  return dispatchMonitorDetail(type, id);
}

export async function updateMonitorByType(
  type: string,
  id: number,
  body: Record<string, unknown>,
): Promise<MonitorRouteResult> {
  return dispatchMonitorUpdate(type, id, body);
}

export async function runMonitorNow(
  type: string,
  id: number,
  deps: Pick<RouteDeps, 'urlQ' | 'apiQ' | 'qaQ' | 'tcpQ' | 'udpQ' | 'dbQ' | 'tlsQ'>,
): Promise<MonitorRouteResult> {
  return dispatchMonitorRun(type, id, deps);
}
