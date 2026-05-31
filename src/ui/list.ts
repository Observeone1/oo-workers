import type { MonType, Monitor } from './types';
import {
  $,
  $$,
  esc,
  fmtAge,
  fmtAgeLive,
  statusClass,
  paginate,
  paginationFooter,
  wirePagination,
} from './helpers';
import {
  apiFetch,
  getMonitors,
  getRegions,
  getAvailability,
  runMonitor,
  toggleMonitor,
  deleteMonitor,
} from './api';
import type { AvailabilityDay } from './types';
import type { RegionLite } from './api';
import { confirmDialog } from './dialogs';
import { getActiveIncidents } from './incidents';
import { openEditDialog } from './dialogs/add-monitor-dialog';
import { on as onStreamEvent } from './events';

// Live updates from the /api/events SSE stream. The list re-renders on every
// dashboard-visible change without waiting for a poll:
//   - monitor-created / monitor-deleted: lifecycle, rare → render promptly.
//   - execution / monitor-state: status + latency + last-run, fire on every
//     monitor's interval → coalesce a burst into one render ~1s later.
// The poll that used to drive status/latency was removed in v1.26.0 but the
// execution/monitor-state wiring was never added, so the list silently stopped
// updating live until v1.28.2 — this block.
let liveSubscribed = false;
let liveRenderTimer: ReturnType<typeof setTimeout> | null = null;
// Only re-render while the list is the visible view. execution/monitor-state
// keep arriving while the operator is on a detail or section page, and
// renderList() writes into #main — re-rendering then would yank them away.
function rerenderIfListVisible(): void {
  if (!main.querySelector('[data-testid="monitors-tab-url"]')) return;
  void renderList();
}
function subscribeListLive(): void {
  if (liveSubscribed) return;
  liveSubscribed = true;
  onStreamEvent('monitor-created', rerenderIfListVisible);
  onStreamEvent('monitor-deleted', rerenderIfListVisible);
  const scheduleRender = () => {
    if (liveRenderTimer) return;
    liveRenderTimer = setTimeout(() => {
      liveRenderTimer = null;
      rerenderIfListVisible();
    }, 1000);
  };
  onStreamEvent('execution', scheduleRender);
  onStreamEvent('monitor-state', scheduleRender);
}

const main = $('#main');

const PAGE_SIZE = 20;

let activeTab: MonType = 'url';
let search = '';
let page = 1;

export function setActiveTab(t: MonType) {
  activeTab = t;
  search = '';
  page = 1;
}

/** Active tab in the list view. Read by the add-monitor dialog so a fresh
 * "+ Add monitor" click pre-selects the type tile matching the visible tab. */
export function getActiveTab(): MonType {
  return activeTab;
}

function targetFor(m: Monitor): string {
  if (m.type === 'heartbeat') {
    // Heartbeats have no target host/url — show last-ping status + age.
    if (m.status === 'PENDING') return 'waiting for first ping';
    if (m.status === 'OVERDUE') return `OVERDUE since ${fmtAge(m.lastPingAt ?? undefined)}`;
    return m.lastPingAt ? `pinged ${fmtAge(m.lastPingAt)}` : 'no pings yet';
  }
  if (m.host) {
    const hostPort = `${m.host}:${m.port ?? ''}`;
    return m.protocol ? `${m.protocol} ${hostPort}` : hostPort;
  }
  return m.url ?? m.targetUrl ?? '';
}

function filterMonitors(monitors: Monitor[], q: string): Monitor[] {
  const trimmed = q.trim().toLowerCase();
  if (!trimmed) return monitors;
  return monitors.filter((m) => {
    return m.name.toLowerCase().includes(trimmed) || targetFor(m).toLowerCase().includes(trimmed);
  });
}

function regionCell(r: RegionLite): string {
  const bars = Array.from({ length: 24 }, (_, i) => {
    if (!r.online) return '<i class="gap"></i>';
    const rnd = Math.sin(i * 13.7 + (r.id ?? 0)) * 0.5 + 0.5;
    if (rnd < 0.03) return '<i class="down"></i>';
    if (rnd < 0.08) return '<i class="warn"></i>';
    return '<i></i>';
  }).join('');

  const lastSeen = fmtAge(r.lastSeenAt);
  return `
    <div class="region-cell ${r.online ? '' : 'offline'}">
      <div class="top">
        <span style="display:flex;align-items:center;gap:6px;min-width:0">
          <span class="dot ${r.online ? 'up' : ''}"></span>
          <span class="slug">${esc(r.slug)}</span>
        </span>
        <span class="label">${esc(r.label)}</span>
      </div>
      <div class="heat">${bars}</div>
      <div class="meta">
        <span><b>99.9%</b> uptime</span>
        <span class="spacer" style="flex:1"></span>
        <span>${r.online ? lastSeen : `offline · ${lastSeen}`}</span>
      </div>
    </div>`;
}

function activityRows(allMonitors: Monitor[], regions: RegionLite[]): string {
  const regionMap = new Map(regions.map((r) => [r.id, r.slug]));

  const runs = allMonitors
    .filter((m) => m.latest)
    .sort((a, b) => (b.latest?.startTime ?? '').localeCompare(a.latest?.startTime ?? ''))
    .slice(0, 8);

  if (runs.length === 0) {
    return `<div class="row" style="justify-content:center;color:var(--muted);padding:14px">No runs yet</div>`;
  }

  return runs
    .map((m, i) => {
      const lat = m.latest?.responseTimeMs ?? m.latest?.durationMs;
      const cls = statusClass(m.latest?.status);
      const regionSlug = m.latest?.regionId != null ? regionMap.get(m.latest.regionId) : null;
      const atRegion = regionSlug ? `<span class="at"> · @${esc(regionSlug)}</span>` : '';
      // Format as HH:MM:SS if available, else relative
      let timeStr = fmtAge(m.latest?.startTime);
      try {
        if (m.latest?.startTime) {
          const d = new Date(m.latest.startTime);
          timeStr = d.toLocaleTimeString('en-GB', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
          });
        }
      } catch {
        /* keep relative */
      }
      return `
      <div class="row${i < 2 ? ' new' : ''}">
        <span class="time">${timeStr}</span>
        <span class="target">${esc(m.name)}${atRegion}</span>
        <span class="lat">${lat != null ? `${lat}ms` : '—'}</span>
        <span class="dot ${cls}"></span>
      </div>`;
    })
    .join('');
}

export async function renderList() {
  // Subscribe lazily on first render — keeps list-view event handlers
  // out of memory until the operator actually navigates here.
  subscribeListLive();

  const searchWasFocused = document.activeElement?.id === 'search-input';

  const [data, regions, avail, incidentsResult] = await Promise.all([
    getMonitors(),
    getRegions().catch(() => [] as RegionLite[]),
    getAvailability(30).catch(() => [] as AvailabilityDay[]),
    getActiveIncidents().catch(() => ({ widget: '', count: 0 })),
  ]);
  const incidentWidget = incidentsResult.widget;
  const activeIncidentCount = incidentsResult.count;

  const counts = {
    url: data.url.length,
    api: data.api.length,
    qa: data.qa.length,
    tcp: data.tcp.length,
    udp: data.udp.length,
    db: data.db.length,
    tls: data.tls.length,
    heartbeat: data.heartbeat.length,
  };

  const allForTab = data[activeTab];
  const filtered = filterMonitors(allForTab, search);
  const { pageRows, totalPages, page: safePage } = paginate(filtered, page, PAGE_SIZE);
  page = safePage;
  const start = (page - 1) * PAGE_SIZE;

  const showingFrom = filtered.length === 0 ? 0 : start + 1;
  const showingTo = Math.min(start + PAGE_SIZE, filtered.length);

  // Fleet stats
  const allMonitors = [
    ...data.url,
    ...data.api,
    ...data.qa,
    ...data.tcp,
    ...data.udp,
    ...data.db,
    ...data.tls,
    ...data.heartbeat,
  ];
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
  const isIncident = downCount > 0;

  // 30-bar real uptime strip from historical execution data
  const availBuckets =
    avail.length === 30
      ? avail
      : Array.from({ length: 30 }, (_, i) => {
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
  const uptimeBars = availBuckets
    .map((day) => {
      if (day.total === 0) return `<i class="empty" title="${day.date || 'No data'}"></i>`;
      const pct = day.passed / day.total;
      const label = `${day.date}: ${Math.round(pct * 100)}% (${day.passed}/${day.total})`;
      if (pct >= 0.99) return `<i title="${label}"></i>`;
      if (pct >= 0.5) return `<i class="warn" title="${label}"></i>`;
      return `<i class="down" title="${label}"></i>`;
    })
    .join('');

  const statusBanner = isIncident
    ? `<div class="status-banner down">
        <div class="status-icon down">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="text">
          <div class="head">Degraded · ${downCount} monitor${downCount !== 1 ? 's' : ''} down</div>
          <div class="sub">${upCount}/${totalActive} active monitors passing</div>
        </div>
        <div class="uptime-strip">
          <span class="label">30D availability</span>
          <div class="uptime-bars">${uptimeBars}</div>
        </div>
      </div>`
    : `<div class="status-banner ok">
        <div class="status-icon ok">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="text">
          <div class="head">All systems operational</div>
          <div class="sub">${upCount}/${totalActive} active monitors passing</div>
        </div>
        <div class="uptime-strip">
          <span class="label">30D availability</span>
          <div class="uptime-bars">${uptimeBars}</div>
        </div>
      </div>`;

  const upPct = totalActive === 0 ? '—' : ((upCount / totalActive) * 100).toFixed(2) + '%';

  const onlineRegionCount = regions.filter((r) => r.online).length;

  const statStrip = `
    <div class="stat-strip">
      <div class="stat">
        <span class="label">Up</span>
        <span class="value">${upCount}<span class="unit">/${totalActive}</span></span>
        <span class="delta up">${upPct} availability</span>
      </div>
      <div class="stat">
        <span class="label">Incidents now</span>
        <span class="value" style="color:${activeIncidentCount ? 'var(--down-text)' : 'var(--text)'}">${activeIncidentCount}</span>
        <span class="delta up">across active monitors</span>
      </div>
      <div class="stat">
        <span class="label">P95 latency</span>
        <span class="value">${p95 != null ? p95 : '—'}<span class="unit">${p95 != null ? 'ms' : ''}</span></span>
        <span class="delta up">across active monitors</span>
      </div>
      <div class="stat">
        <span class="label">Total monitors</span>
        <span class="value">${totalAll}</span>
        <span class="delta up">${totalActive} active${onlineRegionCount > 0 ? `, ${onlineRegionCount} region${onlineRegionCount !== 1 ? 's' : ''}` : ''}</span>
      </div>
    </div>`;

  const onlineRegions = regions.filter((r) => r.online).length;
  const fleetSection =
    regions.length === 0
      ? ''
      : `
    <div class="fleet">
      <section class="panel">
        <div class="panel-head">
          <span class="h"><em>Region fleet</em> · last 24h</span>
          <span class="right">
            <span class="dot ${onlineRegions === regions.length ? 'up' : onlineRegions > 0 ? 'warn' : ''}"></span>
            ${onlineRegions}/${regions.length} online
            <a href="#/regions" style="color:var(--accent);font-size:var(--fs-12);margin-left:4px">Manage →</a>
          </span>
        </div>
        <div class="panel-body tight">
          <div class="regions-grid-overview">
            ${regions.map(regionCell).join('')}
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head">
          <span class="h"><em>Live runs</em></span>
          <span class="right"><span class="dot up"></span> streaming</span>
        </div>
        <div class="panel-body tight">
          <div class="activity scroll-inset">
            ${activityRows(allMonitors, regions)}
          </div>
        </div>
      </section>
    </div>`;

  main.innerHTML = `
    <div class="overview">
      ${statusBanner}
      ${statStrip}
    </div>
    ${fleetSection}
    ${incidentWidget}
    <div class="tabs">
      ${(['url', 'api', 'qa', 'tcp', 'udp', 'db', 'tls', 'heartbeat'] as const)
        .map(
          (t) =>
            `<button class="tab ${t === activeTab ? 'active' : ''}" data-tab="${t}" data-testid="monitors-tab-${t}">${t.toUpperCase()}<span class="count" data-testid="monitors-tab-${t}-count">${counts[t]}</span></button>`,
        )
        .join('')}
    </div>
    <div class="list-toolbar">
      <input id="search-input" data-testid="monitors-search-input" class="search" type="search" placeholder="Filter by name or URL…" value="${esc(search)}" autocomplete="off" />
      <span class="showing-count" data-testid="monitors-summary">
        ${
          filtered.length === 0
            ? search
              ? `No matches for "${esc(search)}"`
              : 'No monitors'
            : `${showingFrom}–${showingTo} of ${filtered.length}${search ? ` (filtered from ${allForTab.length})` : ''}`
        }
      </span>
    </div>
    ${
      pageRows.length === 0
        ? `<div class="empty" data-testid="list-empty">${
            search
              ? `No ${activeTab.toUpperCase()} monitors match "${esc(search)}". <a href="#" data-clear-search data-testid="search-clear-link">Clear search</a>.`
              : `No ${activeTab.toUpperCase()} monitors yet. <a href="#" class="empty-cta" data-tab-add="${activeTab}" data-testid="empty-state-add-link">Add a ${activeTab.toUpperCase()} monitor</a> to create one.`
          }</div>`
        : `<div class="tbl-wrap">
          <table>
            <thead><tr><th></th><th>Name</th><th>Interval</th><th>Last run</th><th>Latency · 30 runs</th><th></th></tr></thead>
            <tbody>${pageRows.map(rowFor).join('')}</tbody>
          </table>
        </div>
        ${paginationFooter(page, totalPages)}`
    }
  `;

  wireTabs();
  wireRowActions();
  wireSearch(searchWasFocused);
  wirePagination(document, page, totalPages, (next) => {
    page = next;
    renderList();
  });
}

function wireTabs() {
  $$<HTMLButtonElement>('.tab[data-tab]').forEach((t) =>
    t.addEventListener('click', () => {
      const tab = t.dataset.tab as MonType;
      if (tab === activeTab) return;
      activeTab = tab;
      search = '';
      page = 1;
      renderList();
    }),
  );
}

function wireRowActions() {
  $$('[data-edit]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { type, id } = (e.currentTarget as HTMLElement).dataset;
      const res = await apiFetch(`/api/monitors/${type}/${id}`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      await openEditDialog(type as import('./types').MonType, Number(id), data.monitor, {
        assertions: data.assertions,
        tests: data.tests,
      });
    }),
  );
  $$('[data-run]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { type, id } = (e.currentTarget as HTMLElement).dataset;
      await runMonitor(type as MonType, Number(id));
      setTimeout(renderList, 800);
    }),
  );
  $$('[data-toggle]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { type, id, enabled } = (e.currentTarget as HTMLElement).dataset;
      await toggleMonitor(type as MonType, Number(id), enabled === 'false');
      renderList();
    }),
  );
  $$('[data-del]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { type, id } = (e.currentTarget as HTMLElement).dataset;
      const ok = await confirmDialog({
        title: 'Delete monitor',
        body: 'Delete this monitor?',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      await deleteMonitor(type as MonType, Number(id));
      renderList();
    }),
  );
  $$('[data-open]').forEach((b) =>
    b.addEventListener('click', () => {
      const { type, id } = (b as HTMLElement).dataset;
      location.hash = `#/${type}/${id}`;
    }),
  );
}

function wireSearch(wasFocused: boolean) {
  const input = document.getElementById('search-input') as HTMLInputElement | null;
  if (!input) return;

  if (wasFocused) {
    const cursor = input.value.length;
    input.focus();
    try {
      input.setSelectionRange(cursor, cursor);
    } catch {
      // setSelectionRange throws on type="search" in some browsers; ignore.
    }
  }

  input.addEventListener('input', () => {
    search = input.value;
    page = 1;
    renderList();
  });

  const clear = document.querySelector('[data-clear-search]');
  clear?.addEventListener('click', (e) => {
    e.preventDefault();
    search = '';
    page = 1;
    renderList();
  });
}

function rowFor(m: Monitor): string {
  // Heartbeats use their own status (UP/OVERDUE/PENDING) on `m.status`,
  // not the run-result pipeline that other types route through `m.latest`.
  const cls = m.type === 'heartbeat' ? statusClass(m.status) : statusClass(m.latest?.status);
  const latency = m.latest?.responseTimeMs ?? m.latest?.durationMs;
  const target = targetFor(m);
  // Schedule cell: heartbeats use period + grace, not interval.
  const schedule =
    m.type === 'heartbeat'
      ? `every ${m.periodSeconds ?? '?'}s + ${m.graceSeconds ?? 0}s grace`
      : `every ${m.intervalSeconds}s`;
  // Last-event cell: heartbeats show lastPingAt; others use latest.startTime.
  // fmtAgeLive so the clock-tick advances "Xs ago" without re-rendering.
  const lastEvent =
    m.type === 'heartbeat'
      ? fmtAgeLive(m.lastPingAt ?? undefined)
      : fmtAgeLive(m.latest?.startTime);
  return `
    <tr class="clickable${m.enabled ? '' : ' disabled'}" data-open data-type="${m.type}" data-id="${m.id}">
      <td class="col-status"><span class="dot ${cls}"></span></td>
      <td class="col-name">
        <div class="name">${esc(m.name)}</div>
        <span class="target" data-testid="monitor-row-target">${esc(target)}${m.type === 'qa' ? ` · ${m.testCount ?? 0} test(s)` : ''}</span>
      </td>
      <td><span class="pill">${schedule}</span></td>
      <td class="cell-meta">${lastEvent}</td>
      <td class="cell-num">
        ${m.type === 'heartbeat' ? '—' : latency != null ? `${latency}<span class="dim">ms</span>` : '—'}
      </td>
      <td class="col-actions">
        <div class="row-actions">
          <button class="btn sm" data-edit data-type="${m.type}" data-id="${m.id}" data-testid="monitor-row-edit" title="Edit">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          ${
            // Heartbeats are push-based (services ping us). No probe to "run".
            m.type === 'heartbeat'
              ? ''
              : `<button class="btn sm" data-run data-type="${m.type}" data-id="${m.id}" title="Run now">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </button>`
          }
          <button class="btn sm" data-toggle data-type="${m.type}" data-id="${m.id}" data-enabled="${m.enabled}" title="${m.enabled ? 'Pause' : 'Resume'}">
            ${
              m.enabled
                ? `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`
                : `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>`
            }
          </button>
          <button class="btn sm danger" data-del data-type="${m.type}" data-id="${m.id}" title="Delete">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
          </button>
        </div>
      </td>
    </tr>`;
}
