import type { MonType, Monitor } from './types';
import { $, $$, esc, fmtAge, statusClass } from './helpers';
import { getMonitors, runMonitor, toggleMonitor, deleteMonitor } from './api';
import { confirmDialog } from './dialogs';

const main = $('#main');

const PAGE_SIZE = 20;

// Module-local view state. Search and page reset on tab change.
let activeTab: MonType = 'url';
let search = '';
let page = 1;

export function setActiveTab(t: MonType) {
  activeTab = t;
  search = '';
  page = 1;
}

function targetFor(m: Monitor): string {
  if (m.host) return `${m.host}:${m.port ?? ''}`;
  return m.url ?? m.targetUrl ?? '';
}

function filterMonitors(monitors: Monitor[], q: string): Monitor[] {
  const trimmed = q.trim().toLowerCase();
  if (!trimmed) return monitors;
  return monitors.filter((m) => {
    return m.name.toLowerCase().includes(trimmed) || targetFor(m).toLowerCase().includes(trimmed);
  });
}

export async function renderList() {
  // Capture focus state BEFORE replacing innerHTML so we can restore it.
  const searchWasFocused = document.activeElement?.id === 'search-input';

  const data = await getMonitors();
  const counts = {
    url: data.url.length,
    api: data.api.length,
    qa: data.qa.length,
    tcp: data.tcp.length,
    udp: data.udp.length,
  };

  const allForTab = data[activeTab];
  const filtered = filterMonitors(allForTab, search);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  const start = (page - 1) * PAGE_SIZE;
  const pageRows = filtered.slice(start, start + PAGE_SIZE);

  const showingFrom = filtered.length === 0 ? 0 : start + 1;
  const showingTo = Math.min(start + PAGE_SIZE, filtered.length);

  main.innerHTML = `
    <div class="tabs">
      ${(['url', 'api', 'qa', 'tcp', 'udp'] as const)
        .map(
          (t) =>
            `<div class="tab ${t === activeTab ? 'active' : ''}" data-tab="${t}">${t.toUpperCase()}<span class="count">${counts[t]}</span></div>`,
        )
        .join('')}
    </div>
    <div class="list-toolbar">
      <input id="search-input" class="search" type="search" placeholder="Search name or URL…" value="${esc(search)}" autocomplete="off" />
      <span class="meta showing-count">
        ${
          filtered.length === 0
            ? search
              ? `No matches for "${esc(search)}"`
              : 'No monitors'
            : `Showing ${showingFrom}–${showingTo} of ${filtered.length}${search ? ` (filtered from ${allForTab.length})` : ''}`
        }
      </span>
    </div>
    ${
      pageRows.length === 0
        ? `<div class="empty">${
            search
              ? `No ${activeTab.toUpperCase()} monitors match "${esc(search)}". <a href="#" data-clear-search>Clear search</a>.`
              : `No ${activeTab.toUpperCase()} monitors yet. Click <b>+ Add monitor</b> to create one.`
          }</div>`
        : `<table>
          <thead><tr><th></th><th>Name</th><th>Interval</th><th>Last run</th><th>Latency</th><th></th></tr></thead>
          <tbody>${pageRows.map(rowFor).join('')}</tbody>
        </table>
        ${
          totalPages > 1
            ? `<div class="pagination">
                <button data-page-prev ${page === 1 ? 'disabled' : ''}>← Prev</button>
                <span class="meta">Page ${page} of ${totalPages}</span>
                <button data-page-next ${page === totalPages ? 'disabled' : ''}>Next →</button>
              </div>`
            : ''
        }`
    }
  `;

  wireTabs();
  wireRowActions();
  wireSearch(searchWasFocused);
  wirePagination(totalPages);
}

function wireTabs() {
  $$('.tab').forEach((t) =>
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

  // Only restore focus if the search input was the active element BEFORE the
  // re-render. Otherwise we'd steal focus on every auto-refresh and row action.
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

function wirePagination(totalPages: number) {
  const prev = document.querySelector('[data-page-prev]');
  const next = document.querySelector('[data-page-next]');
  prev?.addEventListener('click', () => {
    if (page > 1) {
      page--;
      renderList();
    }
  });
  next?.addEventListener('click', () => {
    if (page < totalPages) {
      page++;
      renderList();
    }
  });
}

function rowFor(m: Monitor): string {
  const cls = statusClass(m.latest?.status);
  const latency = m.latest?.responseTimeMs ?? m.latest?.durationMs;
  const target = targetFor(m);
  return `
    <tr class="${m.enabled ? '' : 'disabled'}" data-open data-type="${m.type}" data-id="${m.id}" style="cursor:pointer">
      <td><span class="dot ${cls}"></span></td>
      <td>
        <div class="name">${esc(m.name)}</div>
        <div class="url">${esc(target)}${m.type === 'qa' ? ` · ${m.testCount ?? 0} test(s)` : ''}</div>
      </td>
      <td><span class="pill">every ${m.intervalSeconds}s</span></td>
      <td class="meta">${fmtAge(m.latest?.startTime)}</td>
      <td class="meta">${latency != null ? `${latency}ms` : '—'}</td>
      <td class="row-actions">
        <button data-run data-type="${m.type}" data-id="${m.id}">Run</button>
        <button data-toggle data-type="${m.type}" data-id="${m.id}" data-enabled="${m.enabled}">${m.enabled ? 'Pause' : 'Resume'}</button>
        <button class="danger" data-del data-type="${m.type}" data-id="${m.id}">Delete</button>
      </td>
    </tr>`;
}
