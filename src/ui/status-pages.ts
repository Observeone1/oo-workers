/**
 * Status pages settings — list, create, edit (monitor picker), delete.
 * Routed at #/status-pages. Each page's monitor binding is edited via
 * #/status-pages/<id>.
 */

import { $, esc } from './helpers';
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
import { confirmDialog, alertDialog } from './dialogs';
import { openSlideover, closeSlideover } from './slideover';

// Cache detail for the active page so switching tabs doesn't double-fetch
let cachedDetail: StatusPageDetail | null = null;
let cachedDetailId: number | null = null;

let lastBanner: { kind: 'ok' | 'err'; text: string } | null = null;
let activePageId: number | null = null;

export async function renderStatusPages() {
  const m = location.hash.match(/^#\/status-pages\/(\d+)$/);
  if (m) return renderEditor(Number(m[1]));
  return renderList();
}

// ─── uptime bar helpers ────────────────────────────────────────────────────

/** Deterministic demo bars seeded by monitorId so each monitor looks different */
function buildDemoBars(seed: number): { bars: string; uptimePct: string } {
  let upCount = 0;
  const bars = Array.from({ length: 90 }, (_, i) => {
    const r = Math.abs(Math.sin(seed * 9.7 + i * 3.1 + seed / (i + 1))) % 1;
    const cls = r < 0.015 ? 'down' : r < 0.04 ? 'warn' : 'up';
    if (cls === 'up') upCount++;
    return `<i class="${cls}" title="Day ${90 - i}"></i>`;
  }).join('');
  return { bars, uptimePct: ((upCount / 90) * 100).toFixed(2) };
}

function monitorPreviewCard(name: string, _type: string, seed: number): string {
  const { bars, uptimePct } = buildDemoBars(seed);
  return `
    <div class="public-monitor">
      <div class="top">
        <span class="name"><span class="dot up" style="display:inline-block;margin-right:6px"></span>${esc(name)}</span>
        <span class="pct"><b>${uptimePct}%</b> · 90d</span>
      </div>
      <div class="uptime-90">${bars}</div>
    </div>`;
}

// ─── List view (master/detail sp-layout) ──────────────────────────────────

async function renderList() {
  const main = $('#main');
  const pages = await getStatusPages();
  if (pages.length > 0 && activePageId === null) activePageId = pages[0].id;

  const activePage = pages.find((p) => p.id === activePageId) ?? pages[0] ?? null;

  // Fetch the full detail + all monitor names for the preview
  let detail: StatusPageDetail | null = null;
  let monitorNames: Map<string, string> = new Map();
  if (activePage) {
    if (cachedDetailId === activePage.id && cachedDetail) {
      detail = cachedDetail;
    } else {
      try {
        [detail] = await Promise.all([
          getStatusPage(activePage.id),
          (async () => {
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
          })(),
        ]);
        cachedDetail = detail;
        cachedDetailId = activePage.id;
      } catch {
        detail = null;
      }
    }
  }

  const monitorCount = detail?.monitors.length ?? 0;

  const listItems = pages
    .map(
      (p) => `
    <div class="sp-item${p.id === activePageId ? ' active' : ''}" data-id="${p.id}" data-testid="sp-item-${esc(p.slug)}">
      <div class="ttl">
        ${esc(p.title)}
        <span class="pill mono" style="font-size:10.5px">${p.id === activePageId ? monitorCount : '…'} monitors</span>
      </div>
      <div class="meta">
        <span><span class="muted" style="font-size:var(--fs-12)">/status/</span>${esc(p.slug)}</span>
        <span class="muted">·</span>
        <span><span class="dot up"></span> healthy</span>
      </div>
    </div>
  `,
    )
    .join('');

  // Build preview monitor rows (using public-monitor card with uptime bars)
  let monitorRows = '';
  if (detail && detail.monitors.length > 0) {
    const sorted = [...detail.monitors].sort((a, b) => a.sortOrder - b.sortOrder);
    monitorRows = sorted
      .map((m) => {
        const key = `${m.monitorType}:${m.monitorId}`;
        const name = monitorNames.get(key) ?? `${m.monitorType.toUpperCase()} #${m.monitorId}`;
        return monitorPreviewCard(name, m.monitorType, m.monitorId);
      })
      .join('');
  } else if (detail) {
    monitorRows = `<div style="color:var(--muted);font-size:var(--fs-12);text-align:center;padding:24px 0">
      No monitors linked yet — click <strong>Manage monitors</strong> below.
    </div>`;
  }

  const previewContent = activePage
    ? `
      <div class="preview-bar">
        <span class="dots"><i></i><i></i><i></i></span>
        <span class="url">/status/<b>${esc(activePage.slug)}</b></span>
        <a class="btn sm" href="/status/${esc(activePage.slug)}" target="_blank" rel="noopener">Open ↗</a>
      </div>
      <div class="frame">
        <header class="public-head" style="margin-bottom:var(--s-5)">
          <h1 style="font-size:22px;margin:0 0 6px">${esc(activePage.title)}</h1>
          ${activePage.description ? `<div style="color:var(--muted);font-size:var(--fs-13);margin-bottom:6px">${esc(activePage.description)}</div>` : ''}
          <span class="summary"><span class="dot up"></span> All services healthy</span>
        </header>
        <div class="sp-monitor-list">${monitorRows}</div>
      </div>
      <div class="editor-bar">
        <span class="cap">Editing · ${esc(activePage.title)}</span>
        <span class="spacer"></span>
        <a class="btn sm" href="#/status-pages/${activePage.id}">Manage monitors</a>
        <button class="btn sm danger sp-delete" data-id="${activePage.id}" data-slug="${esc(activePage.slug)}" data-testid="sp-delete-btn">Delete</button>
      </div>`
    : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted)">Create a status page to see the preview.</div>`;

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2 data-testid="page-title">Status pages</h2>
        <div class="sub">Public uptime pages at <code>/status/&lt;slug&gt;</code> — no auth required.</div>
      </div>
      <button class="btn primary" id="new-sp-btn" data-testid="sp-add-btn">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        New page
      </button>
    </div>

    ${lastBanner ? renderBanner(lastBanner) : ''}

    <div class="sp-layout">
      <aside class="sp-list">
        ${listItems}
        <div class="sp-new" id="sp-new-row">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          New status page
        </div>
      </aside>

      <section class="sp-preview">
        ${previewContent}
      </section>
    </div>
  `;

  lastBanner = null;
  wireListView(pages);
  wireCreateBtn();
}

function renderBanner(b: { kind: 'ok' | 'err'; text: string }): string {
  return `<div class="banner banner-${b.kind}" data-testid="banner-${b.kind}">${esc(b.text)}</div>`;
}

function wireListView(pages: StatusPageLite[]) {
  // Sidebar item selection
  document.querySelectorAll<HTMLElement>('.sp-item').forEach((item) => {
    item.addEventListener('click', () => {
      activePageId = Number(item.dataset.id);
      cachedDetail = null; // force fresh detail fetch
      cachedDetailId = null;
      renderList();
    });
  });

  // Delete button in preview bar
  document.querySelectorAll<HTMLButtonElement>('.sp-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const slug = btn.dataset.slug ?? `#${id}`;
      const ok = await confirmDialog({
        title: 'Delete status page',
        body: `Delete '${slug}'? The public URL /status/${slug} will return 404 immediately.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      const res = await deleteStatusPage(id);
      if (!res.ok) {
        alertDialog({ title: 'Delete failed', body: `Delete failed: ${res.status}` });
        btn.disabled = false;
        return;
      }
      lastBanner = { kind: 'ok', text: `Deleted '${slug}'.` };
      const remaining = pages.filter((p) => p.id !== id);
      activePageId = remaining[0]?.id ?? null;
      await renderList();
    });
  });
}

function wireCreateBtn() {
  const openCreate = async () => {
    const allMonitors = await getMonitors();
    const monitorOptions = [
      ...allMonitors.url.map((m) => ({ ...m, type: 'url' as MonType })),
      ...allMonitors.api.map((m) => ({ ...m, type: 'api' as MonType })),
      ...allMonitors.qa.map((m) => ({ ...m, type: 'qa' as MonType })),
      ...allMonitors.tcp.map((m) => ({ ...m, type: 'tcp' as MonType })),
      ...allMonitors.udp.map((m) => ({ ...m, type: 'udp' as MonType })),
    ];
    const pickerHtml =
      monitorOptions.length === 0
        ? `<div style="color:var(--muted);font-size:var(--fs-12);padding:8px 0">No monitors yet — create some first.</div>`
        : monitorOptions
            .map(
              (m) => `
          <label class="pick">
            <input type="checkbox" name="so-mon" value="${m.type}:${m.id}" />
            <span class="dot up"></span>
            <span style="font-weight:500">${esc(m.name)}</span>
            <span class="pill mono" style="margin-left:auto">${m.type.toUpperCase()}</span>
          </label>`,
            )
            .join('');

    openSlideover({
      title: 'New status page',
      body: `
        <div class="form-section">
          <div class="sec-head"><span class="ttl">Basics</span></div>
          <div class="field">
            <label>Title</label>
            <input id="so-sp-title" placeholder="Acme infrastructure" required />
          </div>
          <div class="field">
            <label>Slug</label>
            <div class="input-addon">
              <span class="prefix">/status/</span>
              <input id="so-sp-slug" placeholder="acme" pattern="[a-z0-9][a-z0-9-]{0,62}[a-z0-9]?" required />
            </div>
            <div class="help">Lowercase letters, numbers and dashes only.</div>
          </div>
          <div class="field">
            <label>Description <span style="color:var(--muted);font-size:var(--fs-12)">(optional)</span></label>
            <input id="so-sp-desc" placeholder="Customer-facing service health" />
          </div>
          <p id="so-sp-err" class="banner err" hidden style="margin-top:var(--s-3)"></p>
        </div>
        <div class="form-section">
          <div class="sec-head"><span class="ttl">Monitors</span><span class="opt">select what's public</span></div>
          <div class="picker" style="max-height:240px;overflow-y:auto">${pickerHtml}</div>
        </div>
      `,
      primaryLabel: 'Create page',
      onPrimary: async (so) => {
        const titleEl = so.querySelector<HTMLInputElement>('#so-sp-title')!;
        const slugEl = so.querySelector<HTMLInputElement>('#so-sp-slug')!;
        const descEl = so.querySelector<HTMLInputElement>('#so-sp-desc')!;
        const errEl = so.querySelector<HTMLElement>('#so-sp-err')!;
        const title = titleEl.value.trim();
        const slug = slugEl.value.trim();
        const description = descEl.value.trim() || null;
        if (!title || !slug) {
          errEl.textContent = 'Title and slug are required.';
          errEl.hidden = false;
          throw new Error('validation');
        }
        errEl.hidden = true;
        const { res, data } = await createStatusPage(slug, title, description);
        if (!res.ok) {
          errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
          errEl.hidden = false;
          throw new Error('api');
        }
        closeSlideover();
        lastBanner = { kind: 'ok', text: `Page '${slug}' created — bind monitors next.` };
        location.hash = `#/status-pages/${'id' in data ? data.id : ''}`;
      },
    });
  };

  document.getElementById('new-sp-btn')?.addEventListener('click', openCreate);
  document.getElementById('sp-new-row')?.addEventListener('click', openCreate);
}

// ─── Editor view (monitor picker) ─────────────────────────────────────────

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
    <div class="page-head">
      <div>
        <a class="back-link" href="#/status-pages" style="display:inline-flex;align-items:center;gap:6px;margin-bottom:4px;font-size:var(--fs-12);color:var(--muted)">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          Back to status pages
        </a>
        <h2>${esc(detail.title)}</h2>
        <div class="sub">Slug: <code>${esc(detail.slug)}</code> · <a href="${publicUrl}" target="_blank" rel="noopener">↗ open public page</a></div>
      </div>
      <div style="display:flex;gap:var(--s-2)">
        <a href="${publicUrl}" target="_blank" rel="noopener" class="btn">Open public page</a>
      </div>
    </div>

    ${lastBanner ? renderBanner(lastBanner) : ''}

    <div class="panel" style="margin-bottom:var(--s-5)">
      <div class="panel-head">
        <span class="h">Monitors on this page</span>
        <span class="right">Check which monitors to include — saved immediately</span>
      </div>
      <form id="status-page-edit-form" class="panel-body">
        ${sections
          .map((s) =>
            s.items.length === 0
              ? ''
              : `
          <div style="margin-bottom:var(--s-4)">
            <div class="panel-head" style="margin:0 calc(-1 * var(--s-4));padding:6px var(--s-4);border-bottom:none;border-top:1px solid var(--border)">
              <span class="h">${esc(s.label)} <em>(${s.items.length})</em></span>
            </div>
            <div class="picker" style="margin-top:var(--s-3)">
              ${s.items
                .map(
                  (m) => `
                <label class="pick">
                  <input type="checkbox" name="m" value="${s.type}:${m.id}" ${bound.has(`${s.type}:${m.id}`) ? 'checked' : ''} />
                  <span class="dot up"></span>
                  <span style="font-weight:500">${esc(m.name)}</span>
                  <span class="pill mono" style="margin-left:auto">${esc(s.label)}</span>
                </label>
              `,
                )
                .join('')}
            </div>
          </div>
        `,
          )
          .join('')}
        <div style="margin-top:var(--s-5);display:flex;gap:var(--s-2)">
          <button type="submit" class="btn primary">Save</button>
          <a href="#/status-pages" class="btn">← Back</a>
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
      alertDialog({ title: 'Save failed', body: `Save failed: ${res.status}` });
      return;
    }
    lastBanner = {
      kind: 'ok',
      text: `Saved — ${monitors.length} monitor${monitors.length !== 1 ? 's' : ''} on this page.`,
    };
    cachedDetail = null; // bust cache so list view re-fetches
    cachedDetailId = null;
    await renderEditor(detail.id);
  });
}
