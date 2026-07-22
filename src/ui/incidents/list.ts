/**
 * Incidents — list view. Status-page picker + filter tabs (all / active /
 * resolved) + create-incident slide-in panel + per-incident cards
 * (open + delete).
 */
import { $, esc, fmtAge } from '../helpers';
import {
  createIncident,
  deleteIncident,
  getIncidents,
  getStatusPages,
  type IncidentLite,
  type Severity,
  type StatusPageLite,
} from '../api';
import { confirmDialog, alertDialog } from '../dialogs';
import { SEV_LABEL, SEVERITIES, renderBanner, sevPill, state } from './state.ts';

export async function renderList(): Promise<void> {
  const main = $('#main');
  const pages = await getStatusPages();

  if (pages.length === 0) {
    main.innerHTML = `
      <div class="page-head">
        <div><h2>Incidents</h2><div class="sub">No status pages yet.</div></div>
      </div>
      <div class="empty">
        Incidents belong to a status page.
        <a href="#/status-pages">Create a status page first →</a>
      </div>`;
    return;
  }

  if (state.selectedPageId == null || !pages.some((p) => p.id === state.selectedPageId)) {
    state.selectedPageId = pages[0].id;
  }
  const page = pages.find((p) => p.id === state.selectedPageId) as StatusPageLite;
  const incidents = await getIncidents(state.selectedPageId, state.filter);
  const activeCount = incidents.filter((i) => i.resolvedAt == null).length;

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Incidents</h2>
        <div class="sub">
          Human-written timeline posted to
          <a href="/status/${esc(page.slug)}" target="_blank" rel="noopener">/status/${esc(page.slug)}</a>.
          Each incident is a thread of updates.
        </div>
      </div>
      <button class="btn primary" id="inc-create-btn" data-testid="incidents-create-btn">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        New incident
      </button>
    </div>

    ${state.lastBanner ? renderBanner(state.lastBanner) : ''}

    <div class="inc-toolbar">
      <div class="inc-page-select">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <label>Status page</label>
        <select id="inc-page">
          ${pages.map((p) => `<option value="${p.id}" ${p.id === state.selectedPageId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="seg-tabs" role="tablist">
        ${(['all', 'active', 'resolved'] as const)
          .map(
            (f) => `
          <button class="seg-tab ${f === state.filter ? 'active' : ''}" data-filter="${f}" role="tab">
            ${f.charAt(0).toUpperCase() + f.slice(1)}
            ${f === 'active' && activeCount > 0 ? `<span class="seg-badge">${activeCount}</span>` : ''}
          </button>`,
          )
          .join('')}
      </div>
    </div>

    <div class="inc-layout">
      <!-- Incident list -->
      <div class="inc-list">
        ${
          incidents.length === 0
            ? `<div class="empty" style="padding:32px;text-align:center">
               No ${state.filter === 'all' ? '' : state.filter + ' '}incidents.
               ${state.filter === 'all' ? '' : `<a href="#" data-filter="all">Show all</a>`}
             </div>`
            : incidents.map(renderIncidentCard).join('')
        }
      </div>

      <!-- Create panel -->
      <aside class="inc-create-panel" id="inc-create-panel" ${state.createPanelOpen ? '' : 'hidden'}>
        <div class="set-card" style="padding:20px 24px">
          <div class="set-section-head" style="margin-bottom:16px">
            <span class="h">New incident</span>
            <button class="icon-btn" id="inc-create-close" aria-label="Close">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </div>
          <form id="incident-create-form">
            <div class="field">
              <label>Title</label>
              <input name="title" required placeholder="Investigating elevated errors" />
            </div>
            <div class="field">
              <label>Severity</label>
              <select name="severity">
                ${SEVERITIES.map((s) => `<option value="${s}">${esc(SEV_LABEL[s])}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>First update <span style="color:var(--muted);font-size:var(--fs-12)">(markdown: **bold**, \`code\`)</span></label>
              <textarea name="body" required rows="4" placeholder="We are investigating reports of …"></textarea>
            </div>
            <p id="incident-create-error" class="banner err" hidden style="margin-top:8px"></p>
            <div style="display:flex;justify-content:flex-end;margin-top:12px">
              <button type="submit" class="btn primary" data-testid="incident-create-submit">Create incident</button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  `;

  state.lastBanner = null;

  // Page selector — skip full re-render when the create panel is open
  // to avoid wiping in-progress form fields; submit handler reads
  // state.selectedPageId directly so just updating state is enough.
  ($('#inc-page') as HTMLSelectElement).addEventListener('change', (e) => {
    state.selectedPageId = Number((e.target as HTMLSelectElement).value);
    if (!state.createPanelOpen) void renderList();
  });

  // Filter tabs
  document.querySelectorAll<HTMLElement>('.seg-tab[data-filter]').forEach((t) =>
    t.addEventListener('click', () => {
      state.filter = t.dataset.filter as 'all' | 'active' | 'resolved';
      renderList();
    }),
  );

  // Clear filter link
  document.querySelector('[data-filter="all"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.filter = 'all';
    renderList();
  });

  // New incident button → toggle create panel. State-backed so a
  // re-render (page-select change, filter tab) doesn't clobber an
  // open panel mid-typing.
  const createPanel = document.getElementById('inc-create-panel')!;
  document.getElementById('inc-create-btn')?.addEventListener('click', () => {
    state.createPanelOpen = !state.createPanelOpen;
    createPanel.hidden = !state.createPanelOpen;
  });
  document.getElementById('inc-create-close')?.addEventListener('click', () => {
    state.createPanelOpen = false;
    createPanel.hidden = true;
  });

  wireIncidentCards();
  wireCreateForm();
}

function renderIncidentCard(i: IncidentLite): string {
  const resolved = i.resolvedAt != null;
  const age = resolved ? fmtAge(i.resolvedAt!) : fmtAge(i.updatedAt);
  return `
    <article class="inc-card ${resolved ? 'resolved' : 'active'}" data-id="${i.id}" data-title="${esc(i.title)}">
      <div class="inc-card-main">
        <div class="inc-card-top">
          ${sevPill(i.severity)}
          <span class="inc-title">${esc(i.title)}</span>
        </div>
        <div class="inc-meta">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" style="opacity:.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          ${resolved ? `resolved ${age}` : `updated ${age}`}
          · created ${fmtAge(i.createdAt)}
        </div>
      </div>
      <div class="inc-card-acts">
        <a class="btn sm" href="#/incidents/${i.id}">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Open
        </a>
        <button class="btn sm danger incident-delete" data-id="${i.id}" aria-label="Delete">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    </article>`;
}

function wireIncidentCards(): void {
  document.querySelectorAll<HTMLButtonElement>('.incident-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const card = btn.closest<HTMLElement>('.inc-card');
      const title = card?.dataset.title ?? `#${id}`;
      const ok = await confirmDialog({
        title: 'Delete incident',
        body: `Delete '${title}'? It disappears from the public page immediately.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      const res = await deleteIncident(id);
      if (!res.ok) {
        alertDialog({ title: 'Delete failed', body: `Delete failed: ${res.status}` });
        btn.disabled = false;
        return;
      }
      state.lastBanner = { kind: 'ok', text: `Deleted '${title}'.` };
      await renderList();
    });
  });
}

function wireCreateForm(): void {
  const form = document.getElementById('incident-create-form') as HTMLFormElement | null;
  if (!form || state.selectedPageId == null) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const title = String(fd.get('title') ?? '').trim();
    const body = String(fd.get('body') ?? '').trim();
    const severity = String(fd.get('severity') ?? 'investigating') as Severity;
    const errEl = document.getElementById('incident-create-error') as HTMLElement;
    if (!title || !body) {
      errEl.textContent = 'Title and first update are required.';
      errEl.hidden = false;
      return;
    }
    errEl.hidden = true;
    const { res, data } = await createIncident({
      statusPageId: state.selectedPageId as number,
      title,
      severity,
      body,
    });
    if (!res.ok) {
      errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    state.lastBanner = { kind: 'ok', text: `Incident '${title}' posted.` };
    location.hash = `#/incidents/${'id' in data ? data.id : ''}`;
  });
}
