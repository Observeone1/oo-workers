import type { MonType, Monitor } from './types';
import { $, $$, esc, fmtAge, statusClass } from './helpers';
import { getMonitors, runMonitor, toggleMonitor, deleteMonitor } from './api';

const main = $('#main');

let activeTab: MonType = 'url';

export function setActiveTab(t: MonType) {
  activeTab = t;
}

export async function renderList() {
  const data = await getMonitors();
  const counts = { url: data.url.length, api: data.api.length, qa: data.qa.length };
  const monitors = data[activeTab];

  main.innerHTML = `
    <div class="tabs">
      ${(['url', 'api', 'qa'] as const)
        .map(
          (t) =>
            `<div class="tab ${t === activeTab ? 'active' : ''}" data-tab="${t}">${t.toUpperCase()}<span class="count">${counts[t]}</span></div>`,
        )
        .join('')}
    </div>
    ${
      monitors.length === 0
        ? `<div class="empty">No ${activeTab.toUpperCase()} monitors yet. Click <b>+ Add monitor</b> to create one.</div>`
        : `<table>
          <thead><tr><th></th><th>Name</th><th>Interval</th><th>Last run</th><th>Latency</th><th></th></tr></thead>
          <tbody>${monitors.map(rowFor).join('')}</tbody>
        </table>`
    }
  `;

  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      activeTab = t.dataset.tab as MonType;
      renderList();
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
      if (!confirm('Delete this monitor?')) return;
      const { type, id } = (e.currentTarget as HTMLElement).dataset;
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

function rowFor(m: Monitor): string {
  const cls = statusClass(m.latest?.status);
  const latency = m.latest?.responseTimeMs ?? m.latest?.durationMs;
  const url = m.url ?? m.targetUrl ?? '';
  return `
    <tr class="${m.enabled ? '' : 'disabled'}" data-open data-type="${m.type}" data-id="${m.id}" style="cursor:pointer">
      <td><span class="dot ${cls}"></span></td>
      <td>
        <div class="name">${esc(m.name)}</div>
        <div class="url">${esc(url)}${m.type === 'qa' ? ` · ${m.testCount ?? 0} test(s)` : ''}</div>
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
