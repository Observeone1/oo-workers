/**
 * Incidents settings — operator-authored status-page timeline.
 *
 * Routed at #/incidents (list, page-scoped, Active/Resolved filter) and
 * #/incidents/<id> (editor: rename + the update thread + post-update).
 * Incidents are page-scoped; the public render lives on /status/<slug>.
 * Mirrors status-pages.ts structure.
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
  const sev = (SEVERITIES as string[]).includes(s) ? s : 'investigating';
  return `<span class="sev-pill sev-${sev}">${esc(SEV_LABEL[sev as Severity])}</span>`;
}

async function renderList() {
  const main = $('#main');
  const pages = await getStatusPages();

  if (pages.length === 0) {
    main.innerHTML = `
      <div class="status-pages-page">
        <div class="status-pages-header"><h2>Incidents</h2></div>
        <p class="meta empty">
          Incidents belong to a status page. <a href="#/status-pages">Create a status page</a>
          first, then post incidents to it.
        </p>
      </div>`;
    return;
  }

  if (selectedPageId == null || !pages.some((p) => p.id === selectedPageId)) {
    selectedPageId = pages[0].id;
  }
  const page = pages.find((p) => p.id === selectedPageId) as StatusPageLite;
  const incidents = await getIncidents(selectedPageId, filter);

  main.innerHTML = `
    <div class="status-pages-page">
      <div class="status-pages-header">
        <h2>Incidents</h2>
        <p class="meta">
          Post a human-written incident timeline to a status page. It renders on
          <a href="/status/${esc(page.slug)}" target="_blank" rel="noopener">/status/${esc(page.slug)}</a>
          above the monitor list. Each incident is a thread of updates.
        </p>
      </div>

      ${lastBanner ? renderBanner(lastBanner) : ''}

      <div class="incidents-toolbar">
        <label>Status page
          <select id="inc-page">
            ${pages
              .map(
                (p) =>
                  `<option value="${p.id}" ${p.id === selectedPageId ? 'selected' : ''}>${esc(
                    p.title,
                  )}</option>`,
              )
              .join('')}
          </select>
        </label>
        <div class="tabs">
          ${(['all', 'active', 'resolved'] as const)
            .map(
              (f) =>
                `<div class="tab ${f === filter ? 'active' : ''}" data-filter="${f}">${f.toUpperCase()}</div>`,
            )
            .join('')}
        </div>
      </div>

      <div class="status-pages-grid">
        <section class="status-pages-list">
          <h3>${filter === 'all' ? 'All' : filter === 'active' ? 'Active' : 'Resolved'} (${
            incidents.length
          })</h3>
          ${
            incidents.length === 0
              ? '<p class="meta empty">No incidents — create one on the right.</p>'
              : incidents.map(renderIncidentRow).join('')
          }
        </section>

        <section class="status-pages-create">
          <h3>New incident</h3>
          <form id="incident-create-form">
            <label>Title</label>
            <input name="title" required placeholder="Investigating elevated errors" />

            <label>Severity</label>
            <select name="severity">
              ${SEVERITIES.map((s) => `<option value="${s}">${esc(SEV_LABEL[s])}</option>`).join('')}
            </select>

            <label>First update (markdown: **bold**, \`code\`)</label>
            <textarea name="body" required rows="4"
              placeholder="We are investigating reports of …"></textarea>

            <div class="dialog-actions">
              <button type="submit" class="primary">Create incident</button>
            </div>
            <p id="incident-create-error" class="login-error" hidden></p>
          </form>
        </section>
      </div>
    </div>
  `;

  lastBanner = null;
  ($('#inc-page') as HTMLSelectElement).addEventListener('change', (e) => {
    selectedPageId = Number((e.target as HTMLSelectElement).value);
    renderList();
  });
  document.querySelectorAll<HTMLElement>('.tab[data-filter]').forEach((t) =>
    t.addEventListener('click', () => {
      filter = t.dataset.filter as 'all' | 'active' | 'resolved';
      renderList();
    }),
  );
  wireIncidentRows();
  wireCreateForm();
}

function renderIncidentRow(i: IncidentLite): string {
  const resolved = i.resolvedAt != null;
  return `
    <div class="status-page-row" data-id="${i.id}" data-title="${esc(i.title)}">
      <div class="status-page-row-main">
        <div>
          <div class="status-page-title">${sevPill(i.severity)} ${esc(i.title)}</div>
          <div class="meta">
            ${resolved ? `resolved ${fmtAge(i.resolvedAt!)}` : `updated ${fmtAge(i.updatedAt)}`}
            · created ${fmtAge(i.createdAt)}
          </div>
        </div>
      </div>
      <div class="status-page-actions">
        <a class="btn" href="#/incidents/${i.id}">Open</a>
        <button class="incident-delete danger" data-id="${i.id}">Delete</button>
      </div>
    </div>
  `;
}

function wireIncidentRows() {
  document.querySelectorAll<HTMLButtonElement>('.incident-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const row = btn.closest<HTMLElement>('.status-page-row');
      const title = row?.dataset.title ?? `#${id}`;
      const ok = await confirmDialog({
        title: 'Delete incident',
        body: `Delete incident '${title}'? It disappears from the public page immediately. This cannot be undone.`,
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
    if (!title || !body) return;
    const errEl = document.getElementById('incident-create-error') as HTMLElement;
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

async function renderEditor(id: number) {
  const main = $('#main');
  const [inc, pages] = await Promise.all([getIncident(id), getStatusPages()]);
  if (!inc || !('id' in inc)) {
    main.innerHTML = `<div class="status-pages-page"><a class="back-link" href="#/incidents">← back</a><p class="meta empty">Incident not found.</p></div>`;
    return;
  }
  const page = pages.find((p) => p.id === inc.statusPageId);
  const publicUrl = page ? `/status/${page.slug}` : null;

  main.innerHTML = `
    <div class="status-pages-page">
      <a class="back-link" href="#/incidents">← back to incidents</a>
      <div class="status-pages-header">
        <h2>${sevPill(inc.severity)} ${esc(inc.title)}</h2>
        <p class="meta">
          created ${fmtAge(inc.createdAt)}${
            inc.resolvedAt ? ` · resolved ${fmtAge(inc.resolvedAt)}` : ''
          }${
            publicUrl
              ? ` · <a href="${publicUrl}" target="_blank" rel="noopener">${esc(publicUrl)}</a>`
              : ''
          }
        </p>
      </div>

      ${lastBanner ? renderBanner(lastBanner) : ''}

      <form id="incident-title-form" class="incident-title-form">
        <input name="title" value="${esc(inc.title)}" required />
        <button type="submit" class="btn">Rename</button>
      </form>

      <section class="incident-thread">
        ${inc.updates
          .map(
            (u) => `
          <div class="upd">
            <div class="upd-meta">${sevPill(u.severity)} <time>${esc(
              new Date(u.createdAt).toUTCString(),
            )}</time></div>
            <pre class="upd-raw">${esc(u.body)}</pre>
          </div>`,
          )
          .join('')}
      </section>

      <section class="status-pages-create">
        <h3>Post update</h3>
        <form id="incident-update-form">
          <label>Severity</label>
          <select name="severity">
            ${SEVERITIES.map(
              (s) =>
                `<option value="${s}" ${s === inc.severity ? 'selected' : ''}>${esc(
                  SEV_LABEL[s],
                )}</option>`,
            ).join('')}
          </select>
          <label>Update (markdown: **bold**, \`code\`; pick “Resolved” to close)</label>
          <textarea name="body" required rows="4" placeholder="Root cause identified — …"></textarea>
          <div class="dialog-actions">
            <button type="submit" class="primary">Post update</button>
          </div>
          <p id="incident-update-error" class="login-error" hidden></p>
        </form>
      </section>
    </div>
  `;

  lastBanner = null;
  wireTitleForm(inc);
  wireUpdateForm(inc);
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
      const msg =
        data && typeof data === 'object' && 'error' in data
          ? String((data as { error: unknown }).error)
          : `request failed (${res.status})`;
      errEl.textContent = msg;
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
