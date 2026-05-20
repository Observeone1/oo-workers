/**
 * Incidents — operator-authored status-page timeline.
 * Routed at #/incidents (list view) and #/incidents/<id> (editor).
 */

import { $, esc, fmtAge } from './helpers';
import {
  addIncidentUpdate,
  createIncident,
  deleteIncident,
  getIncident,
  getIncidents,
  getStatusPages,
  updateIncidentTitle,
  type IncidentDetail,
  type IncidentLite,
  type Severity,
  type StatusPageLite,
} from './api';
import { confirmDialog, alertDialog } from './dialogs';

const SEVERITIES: Severity[] = ['investigating', 'identified', 'monitoring', 'resolved'];
const SEV_LABEL: Record<Severity, string> = {
  investigating: 'Investigating',
  identified: 'Identified',
  monitoring: 'Monitoring',
  resolved: 'Resolved',
};
const SEV_COLOR: Record<Severity, string> = {
  investigating: '#d97706',
  identified: '#ea580c',
  monitoring: '#65a30d',
  resolved: '#16a34a',
};

let selectedPageId: number | null = null;
let filter: 'all' | 'active' | 'resolved' = 'all';
let lastBanner: { kind: 'ok' | 'err'; text: string } | null = null;

export async function renderIncidents() {
  const m = location.hash.match(/^#\/incidents\/(\d+)$/);
  if (m) return renderEditor(Number(m[1]));
  return renderList();
}

function renderBanner(b: { kind: 'ok' | 'err'; text: string }): string {
  return `<div class="banner banner-${b.kind}">${esc(b.text)}</div>`;
}

function sevPill(s: string): string {
  const sev = (SEVERITIES as string[]).includes(s) ? (s as Severity) : 'investigating';
  return `<span class="sev-pill sev-${sev}">${esc(SEV_LABEL[sev])}</span>`;
}

// ── List view ──────────────────────────────────────────────────────────────

async function renderList() {
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

  if (selectedPageId == null || !pages.some((p) => p.id === selectedPageId)) {
    selectedPageId = pages[0].id;
  }
  const page = pages.find((p) => p.id === selectedPageId) as StatusPageLite;
  const incidents = await getIncidents(selectedPageId, filter);
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

    ${lastBanner ? renderBanner(lastBanner) : ''}

    <div class="inc-toolbar">
      <div class="inc-page-select">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <label>Status page</label>
        <select id="inc-page">
          ${pages.map((p) => `<option value="${p.id}" ${p.id === selectedPageId ? 'selected' : ''}>${esc(p.title)}</option>`).join('')}
        </select>
      </div>
      <div class="seg-tabs" role="tablist">
        ${(['all', 'active', 'resolved'] as const)
          .map(
            (f) => `
          <button class="seg-tab ${f === filter ? 'active' : ''}" data-filter="${f}" role="tab">
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
               No ${filter !== 'all' ? filter + ' ' : ''}incidents.
               ${filter !== 'all' ? `<a href="#" data-filter="all">Show all</a>` : ''}
             </div>`
            : incidents.map(renderIncidentCard).join('')
        }
      </div>

      <!-- Create panel -->
      <aside class="inc-create-panel" id="inc-create-panel" hidden>
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
              <button type="submit" class="btn primary">Create incident</button>
            </div>
          </form>
        </div>
      </aside>
    </div>
  `;

  lastBanner = null;

  // Page selector
  ($('#inc-page') as HTMLSelectElement).addEventListener('change', (e) => {
    selectedPageId = Number((e.target as HTMLSelectElement).value);
    renderList();
  });

  // Filter tabs
  document.querySelectorAll<HTMLElement>('.seg-tab[data-filter]').forEach((t) =>
    t.addEventListener('click', () => {
      filter = t.dataset.filter as 'all' | 'active' | 'resolved';
      renderList();
    }),
  );

  // Clear filter link
  document.querySelector('[data-filter="all"]')?.addEventListener('click', (e) => {
    e.preventDefault();
    filter = 'all';
    renderList();
  });

  // New incident button → toggle create panel
  const createPanel = document.getElementById('inc-create-panel')!;
  document.getElementById('inc-create-btn')?.addEventListener('click', () => {
    createPanel.hidden = !createPanel.hidden;
  });
  document.getElementById('inc-create-close')?.addEventListener('click', () => {
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

function wireIncidentCards() {
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
      lastBanner = { kind: 'ok', text: `Deleted '${title}'.` };
      await renderList();
    });
  });
}

function wireCreateForm() {
  const form = document.getElementById('incident-create-form') as HTMLFormElement | null;
  if (!form || selectedPageId == null) return;
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
      statusPageId: selectedPageId as number,
      title,
      severity,
      body,
    });
    if (!res.ok) {
      errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    lastBanner = { kind: 'ok', text: `Incident '${title}' posted.` };
    location.hash = `#/incidents/${'id' in data ? data.id : ''}`;
  });
}

// ── Editor view ────────────────────────────────────────────────────────────

async function renderEditor(id: number) {
  const main = $('#main');
  const [inc, pages] = await Promise.all([getIncident(id), getStatusPages()]);
  if (!inc || !('id' in inc)) {
    main.innerHTML = `<div class="page-head"><a class="back-link" href="#/incidents">← Incidents</a><p class="meta">Incident not found.</p></div>`;
    return;
  }
  const page = pages.find((p) => p.id === inc.statusPageId);
  const publicUrl = page ? `/status/${page.slug}` : null;
  const resolved = inc.resolvedAt != null;

  main.innerHTML = `
    <div class="page-head" style="margin-bottom:20px">
      <div>
        <a class="back-link" href="#/incidents" style="display:inline-flex;align-items:center;gap:5px;font-size:var(--fs-12);color:var(--muted);margin-bottom:6px">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          Back to incidents
        </a>
        <h2 style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          ${sevPill(inc.severity)}
          <span>${esc(inc.title)}</span>
        </h2>
        <div class="sub">
          Created ${fmtAge(inc.createdAt)}
          ${resolved ? ` · Resolved ${fmtAge(inc.resolvedAt!)}` : ''}
          ${publicUrl ? ` · <a href="${publicUrl}" target="_blank" rel="noopener">↗ public page</a>` : ''}
        </div>
      </div>
    </div>

    ${lastBanner ? renderBanner(lastBanner) : ''}

    <div class="inc-editor-layout">
      <!-- Left: thread -->
      <div class="inc-editor-main">
        <!-- Rename -->
        <div class="set-card" style="margin-bottom:16px;padding:16px 20px">
          <form id="incident-title-form" class="incident-title-form">
            <input name="title" value="${esc(inc.title)}" required placeholder="Incident title" />
            <button type="submit" class="btn sm">Rename</button>
          </form>
        </div>

        <!-- Update thread -->
        <div class="inc-thread">
          ${
            inc.updates.length === 0
              ? `<div class="empty" style="padding:24px;text-align:center">No updates yet.</div>`
              : [...inc.updates]
                  .reverse()
                  .map(
                    (u) => `
              <div class="inc-upd">
                <div class="inc-upd-dot" style="background:${SEV_COLOR[u.severity as Severity] ?? 'var(--up)'}"></div>
                <div class="inc-upd-body">
                  <div class="inc-upd-meta">
                    ${sevPill(u.severity)}
                    <time class="inc-upd-time">${new Date(u.createdAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</time>
                    <span class="inc-upd-age">${fmtAge(u.createdAt)}</span>
                  </div>
                  <pre class="upd-raw">${esc(u.body)}</pre>
                </div>
              </div>`,
                  )
                  .join('')
          }
        </div>
      </div>

      <!-- Right: post update -->
      <aside class="inc-editor-side">
        <div class="set-card" style="padding:20px 24px">
          <div class="set-section-head" style="margin-bottom:16px"><span class="h">Post update</span></div>
          <form id="incident-update-form">
            <div class="field">
              <label>Severity</label>
              <select name="severity">
                ${SEVERITIES.map((s) => `<option value="${s}" ${s === inc.severity ? 'selected' : ''}>${esc(SEV_LABEL[s])}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Message <span style="color:var(--muted);font-size:var(--fs-12)">(markdown)</span></label>
              <textarea name="body" required rows="5" placeholder="Root cause identified — …"></textarea>
            </div>
            <div class="help" style="margin-bottom:12px">Pick "Resolved" to close the incident.</div>
            <p id="incident-update-error" class="banner err" hidden style="margin-bottom:8px"></p>
            <button type="submit" class="btn primary" style="width:100%">Post update</button>
          </form>
        </div>

        ${
          resolved
            ? ''
            : `
        <div class="set-card danger-zone" style="margin-top:12px;padding:16px 20px">
          <div class="danger-row">
            <div>
              <div class="t">Resolve incident</div>
              <div class="d">Marks the incident as resolved and closes it on the status page.</div>
            </div>
            <button class="btn sm danger" id="resolve-incident-btn">Resolve</button>
          </div>
        </div>`
        }
      </aside>
    </div>
  `;

  lastBanner = null;
  wireTitleForm(inc);
  wireUpdateForm(inc);
  wireResolveBtn(inc);
}

function wireTitleForm(inc: IncidentDetail) {
  const form = document.getElementById('incident-title-form') as HTMLFormElement | null;
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = String(new FormData(form).get('title') ?? '').trim();
    if (!title || title === inc.title) return;
    const res = await updateIncidentTitle(inc.id, title);
    if (!res.ok) {
      alertDialog({ title: 'Rename failed', body: `Failed: ${res.status}` });
      return;
    }
    lastBanner = { kind: 'ok', text: 'Title updated.' };
    await renderEditor(inc.id);
  });
}

function wireUpdateForm(inc: IncidentDetail) {
  const form = document.getElementById('incident-update-form') as HTMLFormElement | null;
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = String(fd.get('body') ?? '').trim();
    const severity = String(fd.get('severity') ?? 'investigating') as Severity;
    if (!body) return;
    const errEl = document.getElementById('incident-update-error') as HTMLElement;
    errEl.hidden = true;
    const { res, data } = await addIncidentUpdate(inc.id, { severity, body });
    if (!res.ok) {
      errEl.textContent =
        data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : `request failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    lastBanner = {
      kind: 'ok',
      text: severity === 'resolved' ? 'Update posted — incident resolved.' : 'Update posted.',
    };
    await renderEditor(inc.id);
  });
}

function wireResolveBtn(inc: IncidentDetail) {
  const btn = document.getElementById('resolve-incident-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Resolve incident',
      body: `Mark "${inc.title}" as resolved? This will close it on the public status page.`,
      confirmLabel: 'Resolve',
      danger: false,
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = 'Resolving…';
    const { res, data } = await addIncidentUpdate(inc.id, {
      severity: 'resolved',
      body: 'Incident resolved.',
    });
    if (!res.ok) {
      await alertDialog({
        title: 'Resolve failed',
        body:
          data && typeof data === 'object' && 'error' in data
            ? String((data as { error: unknown }).error)
            : `Request failed (${res.status})`,
      });
      btn.disabled = false;
      btn.textContent = 'Resolve';
      return;
    }
    lastBanner = { kind: 'ok', text: 'Incident resolved.' };
    await renderEditor(inc.id);
  });
}

// ── Dashboard widget helper (called from list.ts) ─────────────────────────

/**
 * Fetch active incidents across all status pages.
 * Returns { widget: HTML string (empty if none), count: number }
 */
export async function getActiveIncidents(): Promise<{ widget: string; count: number }> {
  try {
    const pages = await getStatusPages();
    if (pages.length === 0) return { widget: '', count: 0 };
    const allActive = (
      await Promise.all(
        pages.map((p) => getIncidents(p.id, 'active').catch(() => [] as IncidentLite[])),
      )
    ).flat();
    if (allActive.length === 0) return { widget: '', count: 0 };
    const items = allActive
      .slice(0, 3)
      .map((i) => {
        const pageTitle = pages.find((p) => p.id === i.statusPageId)?.title ?? '';
        return `
        <a class="inc-widget-row" href="#/incidents/${i.id}">
          ${sevPill(i.severity)}
          <span class="inc-widget-title">${esc(i.title)}</span>
          <span class="inc-widget-meta">${esc(pageTitle)} · ${fmtAge(i.updatedAt)}</span>
        </a>`;
      })
      .join('');
    const more =
      allActive.length > 3
        ? `<a class="inc-widget-more" href="#/incidents">+${allActive.length - 3} more →</a>`
        : '';
    const widget = `
      <div class="inc-widget">
        <div class="inc-widget-head">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>${allActive.length} active incident${allActive.length !== 1 ? 's' : ''}</span>
          <a href="#/incidents" class="inc-widget-link">View all →</a>
        </div>
        ${items}
        ${more}
      </div>`;
    return { widget, count: allActive.length };
  } catch {
    return { widget: '', count: 0 };
  }
}
