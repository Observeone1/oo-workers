/**
 * API keys settings page — list, create, revoke.
 * Routed under #/keys in app.ts.
 */

import { $, esc, fmtAge } from './helpers';
import { getKeys, createKey, revokeKey, type KeyLite, type KeyScope } from './api';
import { confirmDialog, alertDialog } from './dialogs';
import { openSlideover, closeSlideover } from './slideover';

interface OneTimeKey {
  name: string;
  cleartextKey: string;
}

let oneTimeKey: OneTimeKey | null = null;

export async function renderKeys() {
  const main = $('#main');
  const keys = await getKeys();
  const active = keys.filter((k) => !k.revokedAt).length;
  const agentCount = keys.filter((k) => !k.revokedAt && k.scopes.includes('write')).length;

  const tableRows = keys.map(renderKeyRow).join('');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2>API keys</h2>
        <div class="sub">Bearer tokens for the CLI, agents and API consumers (<code>Authorization: Bearer oo_…</code>). Revoking is immediate and permanent.</div>
      </div>
      <button class="btn primary" id="add-key-btn">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        New key
      </button>
    </div>

    <div id="key-reveal-host">
      ${oneTimeKey ? renderOneTimeKey(oneTimeKey) : ''}
    </div>

    <div class="keys-toolbar">
      <div class="summary">
        <span><b>${active}</b> active</span>
        <span class="sep"></span>
        <span><b>${keys.length - active}</b> revoked</span>
        <span class="sep"></span>
        <span><b>${agentCount}</b> write-scoped</span>
      </div>
      <span class="spacer"></span>
    </div>

    <div class="keys-tbl-wrap">
      <table class="keys-tbl">
        <thead>
          <tr>
            <th>Prefix</th>
            <th>Name</th>
            <th>Scopes</th>
            <th>Created</th>
            <th>Last used</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${tableRows.length ? tableRows : `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted)">No API keys yet — create one to access the API programmatically.</td></tr>`}
        </tbody>
      </table>
    </div>

  `;

  wireKeyRowActions();
  wireCreateBtn();
}

function renderKeyRow(k: KeyLite): string {
  const revoked = !!k.revokedAt;
  const lastUsed = k.lastUsedAt;
  const heat = heatFor(lastUsed);
  const statusPill = revoked
    ? `<span class="pill">revoked</span>`
    : `<span class="pill up"><span class="dot up"></span>active</span>`;
  return `
    <tr class="${revoked ? 'revoked' : ''}" data-key-id="${k.id}" data-name="${esc(k.name)}">
      <td><span class="key-prefix">${esc(k.keyPrefix)}…</span></td>
      <td>${esc(k.name)}</td>
      <td><span class="scope-stack">${k.scopes.map((s) => `<span class="pill scope ${esc(s)}">${esc(s)}</span>`).join('')}</span></td>
      <td class="cell-meta">${fmtAge(k.createdAt)}</td>
      <td class="cell-meta">
        <span class="last-used-bar${heat < 50 ? ' cool' : ''}" style="--w:${heat}%"><i></i></span>
        ${fmtAge(lastUsed)}
      </td>
      <td>${statusPill}</td>
      <td class="col-actions">
        ${revoked ? '' : `<button class="btn sm danger key-revoke" data-key-id="${k.id}">Revoke</button>`}
      </td>
    </tr>
  `;
}

function heatFor(lastUsed: string | null | undefined): number {
  if (!lastUsed) return 5;
  const ms = Date.now() - new Date(lastUsed).getTime();
  const hours = ms / 3_600_000;
  if (hours < 0.5) return 95;
  if (hours < 2)   return 80;
  if (hours < 24)  return 60;
  if (hours < 168) return 40;
  return 15;
}

function renderOneTimeKey(otk: OneTimeKey): string {
  return `
    <div class="reveal" style="margin-bottom:var(--s-5)">
      <h4>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
        Key '${esc(otk.name)}' created — copy it now
      </h4>
      <p class="warning">This is the only time the key is shown. Store it somewhere safe; if you lose it, revoke it and create a new one.</p>
      <div class="key-box">
        <code>${esc(otk.cleartextKey)}</code>
      </div>
      <div style="margin-top:var(--s-3);display:flex;gap:var(--s-2);justify-content:flex-end">
        <button type="button" class="btn" id="copy-key-btn">Copy to clipboard</button>
        <button type="button" class="btn primary" id="dismiss-key-btn">I've copied it</button>
      </div>
    </div>
  `;
}

function wireKeyRowActions() {
  document.querySelectorAll<HTMLButtonElement>('.key-revoke').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.keyId);
      const row = btn.closest<HTMLElement>('tr');
      const name = row?.dataset.name ?? `#${id}`;
      const ok = await confirmDialog({
        title: 'Revoke API key',
        body: `Revoke key '${name}'? Any client using it gets 401 immediately. This cannot be undone — the row stays listed for audit.`,
        confirmLabel: 'Revoke',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      const res = await revokeKey(id);
      if (!res.ok) {
        alertDialog({ title: 'Revoke failed', body: `${res.status} ${await res.text().catch(() => '')}` });
        btn.disabled = false;
        return;
      }
      await renderKeys();
    });
  });

  document.getElementById('copy-key-btn')?.addEventListener('click', async () => {
    if (!oneTimeKey) return;
    try {
      await navigator.clipboard.writeText(oneTimeKey.cleartextKey);
      const btn = document.getElementById('copy-key-btn') as HTMLButtonElement;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy to clipboard'; }, 1500);
    } catch {
      // Clipboard may be blocked in non-secure context.
    }
  });

  document.getElementById('dismiss-key-btn')?.addEventListener('click', () => {
    oneTimeKey = null;
    renderKeys();
  });
}

function wireCreateBtn() {
  document.getElementById('add-key-btn')?.addEventListener('click', () => {
    openSlideover({
      title: 'New API key',
      body: `
        <div class="form-section">
          <div class="sec-head"><span class="ttl">Identification</span></div>
          <div class="field">
            <label>Name</label>
            <input id="so-key-name" placeholder="ci-deploy-bot" required />
            <div class="help">Used in the UI only — keys are identified internally by their prefix.</div>
          </div>
        </div>
        <div class="form-section">
          <div class="sec-head"><span class="ttl">Scopes</span><span class="sec-status">choose what this key can do</span></div>
          <div class="choice-row">
            <label class="choice">
              <input type="checkbox" name="so-scope" value="read" />
              <div class="info">
                <div class="ttl"><span class="pill scope read">read</span></div>
                <div class="desc">List monitors, regions, channels and run history. Safe for dashboards and read-only integrations.</div>
              </div>
            </label>
            <label class="choice">
              <input type="checkbox" name="so-scope" value="write" checked />
              <div class="info">
                <div class="ttl"><span class="pill scope write">write</span></div>
                <div class="desc">Create, edit and delete monitors. Trigger ad-hoc runs. Includes read access.</div>
              </div>
            </label>
          </div>
          <p id="so-key-err" class="banner err" hidden style="margin-top:var(--s-3)"></p>
        </div>
      `,
      primaryLabel: 'Create key',
      onPrimary: async (so) => {
        const nameEl = so.querySelector<HTMLInputElement>('#so-key-name')!;
        const scopeEls = so.querySelectorAll<HTMLInputElement>('input[name="so-scope"]:checked');
        const errEl = so.querySelector<HTMLElement>('#so-key-err')!;
        const name = nameEl.value.trim();
        const scopes = Array.from(scopeEls).map((el) => el.value) as KeyScope[];
        if (!name) {
          errEl.textContent = 'Name is required.';
          errEl.hidden = false;
          throw new Error('validation');
        }
        if (scopes.length === 0) {
          errEl.textContent = 'Pick at least one scope.';
          errEl.hidden = false;
          throw new Error('validation');
        }
        errEl.hidden = true;
        const { res, data } = await createKey(name, scopes);
        if (!res.ok || 'error' in data) {
          errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
          errEl.hidden = false;
          throw new Error('api');
        }
        closeSlideover();
        oneTimeKey = { name: data.name, cleartextKey: data.cleartextKey };
        await renderKeys();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
    });
  });
}
