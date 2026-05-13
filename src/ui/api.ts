import type { MonType, MonitorsByType, MonitorDetail, ImportResult } from './types';

// All requests carry `credentials: 'include'` so the oo_session cookie
// flows on same-origin fetches. Required once OO_AUTH_ENABLED is true.
const COMMON: RequestInit = { credentials: 'include' };

export const getMonitors = async (): Promise<MonitorsByType> =>
  (await fetch('/api/monitors', COMMON)).json();

export const getDetail = async (type: MonType, id: number): Promise<MonitorDetail> =>
  (await fetch(`/api/monitors/${type}/${id}`, COMMON)).json();

export const runMonitor = (type: MonType, id: number) =>
  fetch(`/api/monitors/${type}/${id}/run`, { ...COMMON, method: 'POST' });

export const toggleMonitor = (type: MonType, id: number, enabled: boolean) =>
  fetch(`/api/monitors/${type}/${id}`, {
    ...COMMON,
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });

export const deleteMonitor = (type: MonType, id: number) =>
  fetch(`/api/monitors/${type}/${id}`, { ...COMMON, method: 'DELETE' });

export const createMonitor = (type: MonType, body: unknown) =>
  fetch(`/api/monitors/${type}`, {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const importJson = async (
  payload: unknown,
): Promise<{ res: Response; result: ImportResult }> => {
  const res = await fetch('/api/import', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = (await res.json()) as ImportResult;
  return { res, result };
};
