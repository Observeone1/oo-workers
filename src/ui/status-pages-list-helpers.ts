import { getMonitors, getStatusPage, type StatusPageDetail, type StatusPageLite } from './api';

let cachedDetail: StatusPageDetail | null = null;
let cachedDetailId: number | null = null;

export function invalidateStatusPageDetailCache(): void {
  cachedDetail = null;
  cachedDetailId = null;
}

async function loadMonitorNameMap(): Promise<Map<string, string>> {
  const monitorNames = new Map<string, string>();
  try {
    const all = await getMonitors();
    for (const m of all.url) monitorNames.set(`url:${m.id}`, m.name);
    for (const m of all.api) monitorNames.set(`api:${m.id}`, m.name);
    for (const m of all.qa) monitorNames.set(`qa:${m.id}`, m.name);
    for (const m of all.tcp) monitorNames.set(`tcp:${m.id}`, m.name);
    for (const m of all.udp) monitorNames.set(`udp:${m.id}`, m.name);
    for (const m of all.db) monitorNames.set(`db:${m.id}`, m.name);
    for (const m of all.tls) monitorNames.set(`tls:${m.id}`, m.name);
  } catch {
    /* non-fatal */
  }
  return monitorNames;
}

export async function loadListPageDetail(activePage: StatusPageLite): Promise<{
  detail: StatusPageDetail | null;
  monitorNames: Map<string, string>;
}> {
  if (cachedDetailId === activePage.id && cachedDetail) {
    return { detail: cachedDetail, monitorNames: await loadMonitorNameMap() };
  }
  try {
    const [detail, monitorNames] = await Promise.all([
      getStatusPage(activePage.id),
      loadMonitorNameMap(),
    ]);
    cachedDetail = detail;
    cachedDetailId = activePage.id;
    return { detail, monitorNames };
  } catch {
    return { detail: null, monitorNames: new Map() };
  }
}

export function resolveActiveListPage(
  pages: StatusPageLite[],
  activePageId: number | null,
): { activePageId: number | null; activePage: StatusPageLite | null } {
  const id = pages.length > 0 && activePageId === null ? pages[0].id : activePageId;
  const activePage = pages.find((p) => p.id === id) ?? pages[0] ?? null;
  return { activePageId: activePage?.id ?? null, activePage };
}
