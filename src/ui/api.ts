import type { MonType, MonitorsByType, MonitorDetail, ImportResult } from './types';

// All requests carry `credentials: 'include'` so the oo_session cookie
// flows on same-origin fetches — required for the auth gate.
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

// ---------- regions ----------

export interface RegionLite {
  id: number;
  slug: string;
  label: string;
  lastSeenAt: string | null;
  createdAt: string;
  online: boolean;
}

export const getRegions = async (): Promise<RegionLite[]> =>
  (await fetch('/api/regions', COMMON)).json();

export const createRegion = async (
  slug: string,
  label: string,
): Promise<{
  res: Response;
  data: { region: RegionLite; cleartextKey: string } | { error: string; code?: string };
}> => {
  const res = await fetch('/api/regions', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, label }),
  });
  return { res, data: await res.json() };
};

export const deleteRegion = (id: number) =>
  fetch(`/api/regions/${id}`, { ...COMMON, method: 'DELETE' });

export const rotateRegionKey = async (
  id: number,
): Promise<{ region: RegionLite; cleartextKey: string }> => {
  const res = await fetch(`/api/regions/${id}/rotate-key`, { ...COMMON, method: 'POST' });
  return res.json();
};

export const setMonitorRegions = (type: MonType, id: number, regionIds: number[]) =>
  fetch(`/api/monitors/${type}/${id}/regions`, {
    ...COMMON,
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ regionIds }),
  });
