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

// ---------- alert channels ----------

export type ChannelType = 'webhook' | 'discord' | 'slack' | 'email';

export interface ChannelLite {
  id: number;
  name: string;
  type: ChannelType;
  enabled: boolean;
  createdAt: string;
}

export const getChannels = async (): Promise<ChannelLite[]> =>
  (await fetch('/api/channels', COMMON)).json();

export const createChannel = async (
  name: string,
  type: ChannelType,
  url: string,
): Promise<{ res: Response; data: ChannelLite | { error: string } }> => {
  const res = await fetch('/api/channels', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, type, url }),
  });
  return { res, data: await res.json() };
};

export const deleteChannel = (id: number) =>
  fetch(`/api/channels/${id}`, { ...COMMON, method: 'DELETE' });

export const testChannel = async (
  id: number,
): Promise<{ res: Response; data: { ok: boolean; error?: string } }> => {
  const res = await fetch(`/api/channels/${id}/test`, { ...COMMON, method: 'POST' });
  return { res, data: await res.json().catch(() => ({ ok: false })) };
};

export const setMonitorChannels = (type: MonType, id: number, channelIds: number[]) =>
  fetch(`/api/monitors/${type}/${id}/channels`, {
    ...COMMON,
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channelIds }),
  });

// ---------- status pages ----------

export interface StatusPageLite {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  createdAt: string;
}

export interface StatusPageDetail extends StatusPageLite {
  monitors: Array<{ monitorType: MonType; monitorId: number; sortOrder: number }>;
}

export const getStatusPages = async (): Promise<StatusPageLite[]> =>
  (await fetch('/api/status-pages', COMMON)).json();

export const getStatusPage = async (id: number): Promise<StatusPageDetail> =>
  (await fetch(`/api/status-pages/${id}`, COMMON)).json();

export const createStatusPage = async (
  slug: string,
  title: string,
  description: string | null,
): Promise<{ res: Response; data: StatusPageLite | { error: string } }> => {
  const res = await fetch('/api/status-pages', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, title, description }),
  });
  return { res, data: await res.json() };
};

export const deleteStatusPage = (id: number) =>
  fetch(`/api/status-pages/${id}`, { ...COMMON, method: 'DELETE' });

export const setStatusPageMonitors = (id: number, monitors: Array<{ type: MonType; id: number }>) =>
  fetch(`/api/status-pages/${id}/monitors`, {
    ...COMMON,
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ monitors }),
  });

// ---------- API keys ----------

export type KeyScope = 'read' | 'write';

export interface KeyLite {
  id: number;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export const getKeys = async (): Promise<KeyLite[]> => (await fetch('/api/keys', COMMON)).json();

export const createKey = async (
  name: string,
  scopes: KeyScope[],
): Promise<{
  res: Response;
  data:
    | { id: number; name: string; keyPrefix: string; scopes: string[]; cleartextKey: string }
    | { error: string };
}> => {
  const res = await fetch('/api/keys', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, scopes }),
  });
  return { res, data: await res.json() };
};

export const revokeKey = (id: number) =>
  fetch(`/api/keys/${id}/revoke`, { ...COMMON, method: 'POST' });
