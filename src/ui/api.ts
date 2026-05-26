import type {
  MonType,
  MonitorsByType,
  MonitorDetail,
  ImportResult,
  AvailabilityDay,
} from './types';

// All requests carry `credentials: 'include'` so the oo_session cookie
// flows on same-origin fetches — required for the auth gate.
const COMMON: RequestInit = { credentials: 'include' };

/**
 * fetch() shim that catches "session expired" responses from the auth
 * middleware and redirects to the login screen. Without this, an expired
 * session leaves the dashboard in a confused state where every poll
 * fails with a generic error.
 *
 * The server emits `{ error, code: 'session_expired' }` for cookie-only
 * 401s (vs `code: 'key_invalid'` for Bearer 401s, which the dashboard
 * never sees because the dashboard auths via cookie). On detecting that
 * code, hash-route to #/login so the SPA's router renders the login
 * view. Falls through to the normal Response on every other case so
 * existing call sites keep working.
 */
const _fetch: typeof fetch = globalThis.fetch.bind(globalThis);
export async function apiFetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const r = await _fetch(input, init);
  if (r.status === 401) {
    // Clone before reading the body — callers may also want to parse it.
    const body = await r
      .clone()
      .json()
      .catch(() => null);
    if (body?.code === 'session_expired' && location.hash !== '#/login') {
      location.hash = '#/login';
    }
  }
  return r;
}

export const getMonitors = async (): Promise<MonitorsByType> =>
  (await apiFetch('/api/monitors', COMMON)).json();

export const getAvailability = async (days = 30): Promise<AvailabilityDay[]> =>
  (await apiFetch(`/api/availability?days=${days}`, COMMON)).json();

export const getDetail = async (type: MonType, id: number): Promise<MonitorDetail> =>
  (await apiFetch(`/api/monitors/${type}/${id}`, COMMON)).json();

export const runMonitor = (type: MonType, id: number) =>
  apiFetch(`/api/monitors/${type}/${id}/run`, { ...COMMON, method: 'POST' });

export const toggleMonitor = (type: MonType, id: number, enabled: boolean) =>
  apiFetch(`/api/monitors/${type}/${id}`, {
    ...COMMON,
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });

export const deleteMonitor = (type: MonType, id: number) =>
  apiFetch(`/api/monitors/${type}/${id}`, { ...COMMON, method: 'DELETE' });

export const createMonitor = (type: MonType, body: unknown) =>
  apiFetch(`/api/monitors/${type}`, {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const updateMonitor = (type: MonType, id: number, body: unknown) =>
  apiFetch(`/api/monitors/${type}/${id}`, {
    ...COMMON,
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const importJson = async (
  payload: unknown,
): Promise<{ res: Response; result: ImportResult }> => {
  const res = await apiFetch('/api/import', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = (await res.json()) as ImportResult;
  return { res, result };
};

// ---------- backup / restore ----------

// Download is a plain authed navigation: the oo_session cookie rides along
// on a same-origin GET, and the browser streams the gzip straight to disk
// without buffering it in JS — important for large dumps.
export const backupUrl = (scope: string, since: number, includeArtifacts: boolean) => {
  const qs = `scope=${encodeURIComponent(scope)}&since=${since}`;
  return includeArtifacts ? `/api/backup?${qs}&includeArtifacts=1` : `/api/backup?${qs}`;
};

export interface BackupEstimate {
  artifactCount: number;
  artifactBytes: number;
}

export const backupEstimate = async (): Promise<BackupEstimate> => {
  const res = await apiFetch('/api/backup/estimate', COMMON);
  if (!res.ok) return { artifactCount: 0, artifactBytes: 0 };
  return res.json();
};

export const restoreBackup = async (
  file: File,
  force: boolean,
): Promise<{ res: Response; result: { error?: string; counts?: Record<string, number> } }> => {
  const res = await apiFetch(`/api/restore${force ? '?force=1' : ''}`, {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/gzip' },
    body: file,
  });
  const result = await res.json().catch(() => ({ error: 'unexpected server response' }));
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
  // Roadmap follow-up: version-skew warning. Master sends back its own
  // version per row + the agent's last-reported version + a precomputed
  // skew bool so the UI doesn't have to redo the comparison.
  agentVersion?: string | null;
  masterVersion?: string;
  versionSkew?: boolean;
}

export const getRegions = async (): Promise<RegionLite[]> =>
  (await apiFetch('/api/regions', COMMON)).json();

export const createRegion = async (
  slug: string,
  label: string,
): Promise<{
  res: Response;
  data: { region: RegionLite; cleartextKey: string } | { error: string; code?: string };
}> => {
  const res = await apiFetch('/api/regions', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, label }),
  });
  return { res, data: await res.json() };
};

export const deleteRegion = (id: number) =>
  apiFetch(`/api/regions/${id}`, { ...COMMON, method: 'DELETE' });

export const rotateRegionKey = async (
  id: number,
): Promise<{ region: RegionLite; cleartextKey: string }> => {
  const res = await apiFetch(`/api/regions/${id}/rotate-key`, { ...COMMON, method: 'POST' });
  return res.json();
};

export const setMonitorRegions = (type: MonType, id: number, regionIds: number[]) =>
  apiFetch(`/api/monitors/${type}/${id}/regions`, {
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
  (await apiFetch('/api/channels', COMMON)).json();

export const createChannel = async (
  name: string,
  type: ChannelType,
  url: string,
): Promise<{ res: Response; data: ChannelLite | { error: string } }> => {
  const res = await apiFetch('/api/channels', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, type, url }),
  });
  return { res, data: await res.json() };
};

export const deleteChannel = (id: number) =>
  apiFetch(`/api/channels/${id}`, { ...COMMON, method: 'DELETE' });

export const testChannel = async (
  id: number,
): Promise<{
  res: Response;
  data: {
    ok: boolean;
    error?: string;
    mailpit?: { delivered: boolean; subject?: string; to?: string };
  };
}> => {
  const res = await apiFetch(`/api/channels/${id}/test`, { ...COMMON, method: 'POST' });
  return { res, data: await res.json().catch(() => ({ ok: false })) };
};

export const setMonitorChannels = (type: MonType, id: number, channelIds: number[]) =>
  apiFetch(`/api/monitors/${type}/${id}/channels`, {
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
  (await apiFetch('/api/status-pages', COMMON)).json();

export const getStatusPage = async (id: number): Promise<StatusPageDetail> =>
  (await apiFetch(`/api/status-pages/${id}`, COMMON)).json();

export const createStatusPage = async (
  slug: string,
  title: string,
  description: string | null,
): Promise<{ res: Response; data: StatusPageLite | { error: string } }> => {
  const res = await apiFetch('/api/status-pages', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug, title, description }),
  });
  return { res, data: await res.json() };
};

export const deleteStatusPage = (id: number) =>
  apiFetch(`/api/status-pages/${id}`, { ...COMMON, method: 'DELETE' });

export const setStatusPageMonitors = (id: number, monitors: Array<{ type: MonType; id: number }>) =>
  apiFetch(`/api/status-pages/${id}/monitors`, {
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

export const getKeys = async (): Promise<KeyLite[]> => (await apiFetch('/api/keys', COMMON)).json();

export const createKey = async (
  name: string,
  scopes: KeyScope[],
): Promise<{
  res: Response;
  data:
    | { id: number; name: string; keyPrefix: string; scopes: string[]; cleartextKey: string }
    | { error: string };
}> => {
  const res = await apiFetch('/api/keys', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, scopes }),
  });
  return { res, data: await res.json() };
};

export const revokeKey = (id: number) =>
  apiFetch(`/api/keys/${id}/revoke`, { ...COMMON, method: 'POST' });

// ---------- Incidents (status-page timeline) ----------

export type Severity = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface IncidentLite {
  id: number;
  statusPageId: number;
  title: string;
  severity: Severity;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface IncidentDetail extends IncidentLite {
  updates: Array<{ id: number; severity: Severity; body: string; createdAt: string }>;
}

export const getIncidents = async (
  statusPageId: number,
  filter: 'all' | 'active' | 'resolved' = 'all',
): Promise<IncidentLite[]> =>
  (await apiFetch(`/api/incidents?status_page_id=${statusPageId}&filter=${filter}`, COMMON)).json();

export const getIncident = async (id: number): Promise<IncidentDetail> =>
  (await apiFetch(`/api/incidents/${id}`, COMMON)).json();

export const createIncident = async (data: {
  statusPageId: number;
  title: string;
  severity: Severity;
  body: string;
}): Promise<{ res: Response; data: IncidentLite | { error: string } }> => {
  const res = await apiFetch('/api/incidents', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      status_page_id: data.statusPageId,
      title: data.title,
      severity: data.severity,
      body: data.body,
    }),
  });
  return { res, data: await res.json() };
};

export const addIncidentUpdate = async (
  id: number,
  data: { severity: Severity; body: string },
): Promise<{ res: Response; data: unknown }> => {
  const res = await apiFetch(`/api/incidents/${id}/updates`, {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });
  return { res, data: await res.json().catch(() => ({})) };
};

export const updateIncidentTitle = (id: number, title: string) =>
  apiFetch(`/api/incidents/${id}`, {
    ...COMMON,
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });

export const deleteIncident = (id: number) =>
  apiFetch(`/api/incidents/${id}`, { ...COMMON, method: 'DELETE' });

// ---------- profile / password ----------

export const updateProfile = async (
  name: string,
  email: string,
): Promise<{
  res: Response;
  data: { name: string; email: string; role: string } | { error: string };
}> => {
  const res = await apiFetch('/api/auth/profile', {
    ...COMMON,
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, email }),
  });
  return { res, data: await res.json() };
};

export const changePassword = async (
  currentPassword: string,
  newPassword: string,
): Promise<{ res: Response; data: { ok: boolean } | { error: string } }> => {
  const res = await apiFetch('/api/auth/password', {
    ...COMMON,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  return { res, data: await res.json() };
};
