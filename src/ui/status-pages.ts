/**
 * Status pages settings — list, create, edit (monitor picker), delete.
 *
 * Routed at #/status-pages. Each page has its own monitor-picker view
 * at #/status-pages/<id> so the list stays clean and the picker can
 * stretch to fit large monitor counts.
 */

import { $, esc, fmtAge } from './helpers';
import {
  createStatusPage,
  deleteStatusPage,
  getMonitors,
  getStatusPage,
  getStatusPages,
  setStatusPageMonitors,
  type StatusPageDetail,
  type StatusPageLite,
} from './api';
import type { MonType } from './types';

let lastBanner: { kind: 'ok' | 'err'; text: string } | null = null;

export async function renderStatusPages() {
  // /#/status-pages/<id> drills into the editor.
  const m = location.hash.match(/^#\/status-pages\/(\d+)$/);
  if (m) return renderEditor(Number(m[1]));
  return renderList();
}

async function renderList() {
  const main = $('#main');
  const pages = await getStatusPages();

  main.innerHTML = `
    <div class="status-pages-page">
      <div class="status-pages-header">
        <h2>Status pages</h2>
        <p class="meta">
          Publish a public uptime page for one or more monitors. Each page is reachable at
          <code>/status/&lt;slug&gt;</code> with no auth — share the URL with customers, partners, or
          the world.
        </p>
      </div>

      ${lastBanner ? renderBanner(lastBanner) : ''}

      <div class="status-pages-grid">
        <section class="status-pages-list">
          <h3>Existing (${pages.length})</h3>
          ${
            pages.length === 0
              ? '<p class="meta empty">No status pages yet — create one on the right.</p>'
              : ''
          }
          ${pages.map(renderPageRow).join('')}
        </section>

        <section class="status-pages-create">
          <h3>Add a status page</h3>
          <form id="status-page-create-form">
            <label>Slug (lowercase, dashes)</label>
            <input name="slug" required pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?" placeholder="public" />

            <label>Title</label>
            <input name="title" required placeholder="My services" />

            <label>Description (optional)</label>
            <input name="description" placeholder="Live status of our public APIs" />

            <div class="dialog-actions">
              <button type="submit" class="primary">Create page</button>
            </div>
            <p id="status-page-create-error" class="login-error" hidden></p>
          </form>
        </section>
      </div>
    </div>
  `;

  lastBanner = null;
  wirePageRows();
  wireCreateForm();
}

function renderBanner(b: { kind: 'ok' | 'err'; text: string }): string {
  return `<div class="banner banner-${b.kind}">${esc(b.text)}</div>`;
}

function renderPageRow(p: StatusPageLite): string {
  const publicUrl = `/status/${p.slug}`;
  return `
    <div class="status-page-row" data-id="${p.id}" data-slug="${esc(p.slug)}">
      <div class="status-page-row-main">
        <div>
          <div class="status-page-title">${esc(p.title)}</div>
          <div class="meta">created ${fmtAge(p.createdAt)} · <code>${esc(p.slug)}</code></div>
          <a class="status-page-public" href="${publicUrl}" target="_blank" rel="noopener">
            ↗ ${esc(publicUrl)}
          </a>
        </div>
      </div>
      <div class="status-page-actions">
        <a class="btn status-page-edit" href="#/status-pages/${p.id}">Edit monitors</a>
        <button class="status-page-delete danger" data-id="${p.id}">Delete</button>
      </div>
    </div>
  `;
}

function wirePageRows() {
  document.querySelectorAll<HTMLButtonElement>('.status-page-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const row = btn.closest<HTMLElement>('.status-page-row');
      const slug = row?.dataset.slug ?? `#${id}`;
      if (
        !confirm(
          `Delete status page '${slug}'? The public URL /status/${slug} will return 404 immediately.`,
        )
      )
        return;
      btn.disabled = true;
      const res = await deleteStatusPage(id);
      if (!res.ok) {
        alert(`Delete failed: ${res.status}`);
        btn.disabled = false;
        return;
      }
      lastBanner = { kind: 'ok', text: `Deleted '${slug}'.` };
      await renderList();
    });
  });
}

function wireCreateForm() {
  const form = document.getElementById('status-page-create-form') as HTMLFormElement | null;
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const slug = String(fd.get('slug') ?? '').trim();
    const title = String(fd.get('title') ?? '').trim();
    const description = String(fd.get('description') ?? '').trim() || null;
    if (!slug || !title) return;

    const errEl = document.getElementById('status-page-create-error') as HTMLElement;
    errEl.hidden = true;
    const { res, data } = await createStatusPage(slug, title, description);
    if (!res.ok) {
      errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    lastBanner = {
      kind: 'ok',
      text: `Page '${slug}' created — next, bind monitors so the public page has something to show.`,
    };
    // Drop the operator straight into the editor since a bare page is useless.
    location.hash = `#/status-pages/${'id' in data ? data.id : ''}`;
  });
}

async function renderEditor(id: number) {
  const main = $('#main');
  const [detail, allMonitors] = await Promise.all([getStatusPage(id), getMonitors()]);
  const bound = new Set(detail.monitors.map((b) => `${b.monitorType}:${b.monitorId}`));
  const publicUrl = `/status/${detail.slug}`;

  const sections: Array<{
    type: MonType;
    label: string;
    items: Array<{ id: number; name: string }>;
  }> = [
    { type: 'url', label: 'URL', items: allMonitors.url },
    { type: 'api', label: 'API', items: allMonitors.api },
    { type: 'tcp', label: 'TCP', items: allMonitors.tcp },
    { type: 'udp', label: 'UDP', items: allMonitors.udp },
    { type: 'qa', label: 'Browser', items: allMonitors.qa },
  ];

  main.innerHTML = `
    <div class="status-pages-page">
      <a class="back-link" href="#/status-pages">← back to status pages</a>
      <div class="status-pages-header">
        <h2>${esc(detail.title)}</h2>
        <p class="meta">
          Slug <code>${esc(detail.slug)}</code> · public URL
          <a href="${publicUrl}" target="_blank" rel="noopener">${esc(publicUrl)}</a>
        </p>
      </div>

      ${lastBanner ? renderBanner(lastBanner) : ''}

      <p class="meta">Check the monitors that should appear on this page (in display order).</p>

      <form id="status-page-edit-form" class="status-page-editor">
        ${sections
          .map(
            (s) => `
          <div class="status-page-section">
            <div class="status-page-section-head">${esc(s.label)} (${s.items.length})</div>
            ${
              s.items.length === 0
                ? `<div class="meta">No ${esc(s.label)} monitors yet.</div>`
                : s.items
                    .map(
                      (m) => `
              <label class="monitor-pick">
                <input type="checkbox" name="m" value="${s.type}:${m.id}" ${
                  bound.has(`${s.type}:${m.id}`) ? 'checked' : ''
                } />
                <span class="monitor-pick-name">${esc(m.name)}</span>
              </label>
            `,
                    )
                    .join('')
            }
          </div>
        `,
          )
          .join('')}

        <div class="dialog-actions">
          <button type="submit" class="primary">Save</button>
          <a href="${publicUrl}" target="_blank" rel="noopener" class="btn">Open public page</a>
        </div>
      </form>
    </div>
  `;

  lastBanner = null;
  wireEditorForm(detail);
}

function wireEditorForm(detail: StatusPageDetail) {
  const form = document.getElementById('status-page-edit-form') as HTMLFormElement | null;
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const checked = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="m"]:checked'));
    const monitors = checked.map((cb) => {
      const [type, id] = cb.value.split(':');
      return { type: type as MonType, id: Number(id) };
    });
    const res = await setStatusPageMonitors(detail.id, monitors);
    if (!res.ok) {
      alert(`Save failed: ${res.status}`);
      return;
    }
    lastBanner = { kind: 'ok', text: `Saved — ${monitors.length} monitors on this page.` };
    await renderEditor(detail.id);
  });
}
