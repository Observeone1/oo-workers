import type { AvailabilityDay, Monitor } from './types';
import { esc, statusClass } from './helpers';

export type FleetStats = {
  upCount: number;
  downCount: number;
  totalActive: number;
  totalAll: number;
  p95: number | null;
  isIncident: boolean;
};

export function flattenAllMonitors(data: {
  url: Monitor[];
  api: Monitor[];
  qa: Monitor[];
  tcp: Monitor[];
  udp: Monitor[];
  db: Monitor[];
  tls: Monitor[];
  heartbeat: Monitor[];
}): Monitor[] {
  return [
    ...data.url,
    ...data.api,
    ...data.qa,
    ...data.tcp,
    ...data.udp,
    ...data.db,
    ...data.tls,
    ...data.heartbeat,
  ];
}

export function computeFleetStats(allMonitors: Monitor[]): FleetStats {
  const upCount = allMonitors.filter(
    (m) => m.enabled && statusClass(m.latest?.status) === 'up',
  ).length;
  const downCount = allMonitors.filter(
    (m) => m.enabled && statusClass(m.latest?.status) === 'down',
  ).length;
  const totalActive = allMonitors.filter((m) => m.enabled).length;
  const totalAll = allMonitors.length;
  const latencies = allMonitors
    .filter((m) => m.enabled && statusClass(m.latest?.status) !== 'down')
    .map((m) => m.latest?.responseTimeMs ?? m.latest?.durationMs)
    .filter((l): l is number => l != null)
    .sort((a, b) => a - b);
  const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : null;
  return { upCount, downCount, totalActive, totalAll, p95, isIncident: downCount > 0 };
}

export function normalizeAvailBuckets(avail: AvailabilityDay[]): AvailabilityDay[] {
  if (avail.length === 30) return avail;
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (29 - i));
    return (
      avail.find((a) => a.date === d.toISOString().slice(0, 10)) ?? {
        date: '',
        total: 0,
        passed: 0,
      }
    );
  });
}

export function renderUptimeBars(availBuckets: AvailabilityDay[]): string {
  return availBuckets
    .map((day) => {
      if (day.total === 0) return `<i class="empty" title="${day.date || 'No data'}"></i>`;
      const pct = day.passed / day.total;
      const label = `${day.date}: ${Math.round(pct * 100)}% (${day.passed}/${day.total})`;
      if (pct >= 0.99) return `<i title="${label}"></i>`;
      if (pct >= 0.5) return `<i class="warn" title="${label}"></i>`;
      return `<i class="down" title="${label}"></i>`;
    })
    .join('');
}

export function buildStatusBanner(stats: FleetStats, uptimeBars: string): string {
  const downMonitorSuffix = stats.downCount === 1 ? '' : 's';
  if (stats.isIncident) {
    return `<div class="status-banner down">
        <div class="status-icon down">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="text">
          <div class="head">Degraded · ${stats.downCount} monitor${downMonitorSuffix} down</div>
          <div class="sub">${stats.upCount}/${stats.totalActive} active monitors passing</div>
        </div>
        <div class="uptime-strip">
          <span class="label">30D availability</span>
          <div class="uptime-bars">${uptimeBars}</div>
        </div>
      </div>`;
  }
  return `<div class="status-banner ok">
        <div class="status-icon ok">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="text">
          <div class="head">All systems operational</div>
          <div class="sub">${stats.upCount}/${stats.totalActive} active monitors passing</div>
        </div>
        <div class="uptime-strip">
          <span class="label">30D availability</span>
          <div class="uptime-bars">${uptimeBars}</div>
        </div>
      </div>`;
}

export function buildShowingSummary(opts: {
  filteredLength: number;
  showingFrom: number;
  showingTo: number;
  search: string;
  allForTabLength: number;
}): string {
  const { filteredLength, showingFrom, showingTo, search, allForTabLength } = opts;
  if (filteredLength === 0) {
    return search ? `No matches for "${esc(search)}"` : 'No monitors';
  }
  const filteredNote = search ? ` (filtered from ${allForTabLength})` : '';
  return `${showingFrom}–${showingTo} of ${filteredLength}${filteredNote}`;
}

export function buildEmptyListBody(activeTab: string, search: string): string {
  if (search) {
    return `No ${activeTab.toUpperCase()} monitors match "${esc(search)}". <a href="#" data-clear-search data-testid="search-clear-link">Clear search</a>.`;
  }
  return `No ${activeTab.toUpperCase()} monitors yet. <a href="#" class="empty-cta" data-tab-add="${activeTab}" data-testid="empty-state-add-link">Add a ${activeTab.toUpperCase()} monitor</a> to create one.`;
}
