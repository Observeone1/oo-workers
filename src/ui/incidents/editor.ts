/**
 * Incidents — editor view. Rename + thread of updates + post-update
 * form with severity picker + dedicated Resolve button. Loaded when
 * the URL hash matches `#/incidents/<id>`.
 */
import { $, esc, fmtAge } from '../helpers';
import {
  addIncidentUpdate,
  getIncident,
  getStatusPages,
  updateIncidentTitle,
  type IncidentDetail,
  type Severity,
} from '../api';
import { confirmDialog, alertDialog } from '../dialogs';
import { SEV_COLOR, SEV_LABEL, SEVERITIES, renderBanner, sevPill, state } from './state.ts';

export async function renderEditor(id: number): Promise<void> {
  const main = $('#main');
  const [inc, pages] = await Promise.all([getIncident(id), getStatusPages()]);
  if (!inc || !('id' in inc)) {
    main.innerHTML = `<div class="page-head"><a class="back-link" href="#/incidents">← Incidents</a><p class="meta">Incident not found.</p></div>`;
    return;
  }
  const page = pages.find((p) => p.id === inc.statusPageId);
  const publicUrl = page ? `/status/${esc(page.slug)}` : null;
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

    ${state.lastBanner ? renderBanner(state.lastBanner) : ''}

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
              <textarea name="body" required rows="5" placeholder="Root cause identified..."></textarea>
            </div>
            <div class="help" style="margin-bottom:12px">Pick "Resolved" to close the incident.</div>
            <p id="incident-update-error" class="banner err" hidden style="margin-bottom:8px"></p>
            <button type="submit" class="btn primary" style="width:100%" data-testid="incident-update-submit">Post update</button>
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

  state.lastBanner = null;
  wireTitleForm(inc);
  wireUpdateForm(inc);
  wireResolveBtn(inc);
}

function wireTitleForm(inc: IncidentDetail): void {
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
    state.lastBanner = { kind: 'ok', text: 'Title updated.' };
    await renderEditor(inc.id);
  });
}

function wireUpdateForm(inc: IncidentDetail): void {
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
    state.lastBanner = {
      kind: 'ok',
      text: severity === 'resolved' ? 'Update posted. Incident resolved.' : 'Update posted.',
    };
    await renderEditor(inc.id);
  });
}

function wireResolveBtn(inc: IncidentDetail): void {
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
    state.lastBanner = { kind: 'ok', text: 'Incident resolved.' };
    await renderEditor(inc.id);
  });
}
