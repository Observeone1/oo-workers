/**
 * Settings → API keys section. List + revoke + create-via-slideover.
 * The one-time cleartext reveal is module-local state — only the most
 * recent freshly-created key shows up in the reveal panel, and clearing
 * "I've copied it" wipes it forever.
 */
import { esc, fmtAge } from '../helpers';
import { createKey, getKeys, revokeKey, type KeyLite, type KeyScope } from '../api';
import { confirmDialog, alertDialog } from '../dialogs';
import { openSlideover, closeSlideover } from '../slideover';

interface OneTimeKey {
  name: string;
  cleartextKey: string;
}

let oneTimeKey: OneTimeKey | null = null;

export async function renderKeys(panel: HTMLElement): Promise<void> {
  panel.innerHTML = `
    <div class="set-section-head">
      <div>
        <h3>API keys</h3>
        <p class="sub">Programmatic access to the oo-workers API.</p>
      </div>
      <button class="btn primary" id="s-add-key" data-testid="keys-add-btn">
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>
        New key
      </button>
    </div>

    <div id="s-key-reveal-host"></div>

    <div class="set-card pad-0">
      <div class="keys-toolbar" style="border-radius:var(--r-lg) var(--r-lg) 0 0" id="s-keys-toolbar">
        <div class="summary"><span class="muted" style="font-size:var(--fs-13)">Loading…</span></div>
      </div>
      <div class="keys-tbl-wrap" id="s-keys-tbl-wrap">
        <table class="keys-tbl">
          <thead>
            <tr><th>Prefix</th><th>Name</th><th>Scopes</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr>
          </thead>
          <tbody id="s-keys-tbody"><tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted)">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
    <p class="set-foot-note">Need an agent key for a new region? Create one with the <span class="pill scope agent">agent</span> scope, then paste it into your region's docker env as <code>OO_KEY</code>.</p>
  `;

  await loadKeys(panel);

  panel.querySelector('#s-add-key')?.addEventListener('click', () => openNewKeySlide(panel));
}

async function loadKeys(panel: HTMLElement): Promise<void> {
  const keys = await getKeys().catch(() => [] as KeyLite[]);
  const activeCount = keys.filter((k) => !k.revokedAt).length;

  const toolbar = panel.querySelector('#s-keys-toolbar');
  if (toolbar) {
    toolbar.innerHTML = `
      <div class="summary">
        <span><b>${activeCount}</b> active</span>
        <span class="sep"></span>
        <span><b>${keys.length - activeCount}</b> revoked</span>
      </div>
    `;
  }

  const tbody = panel.querySelector('#s-keys-tbody');
  if (!tbody) return;

  if (oneTimeKey) {
    const host = panel.querySelector<HTMLElement>('#s-key-reveal-host');
    if (host) {
      host.innerHTML = `
        <div class="reveal" style="margin-bottom:var(--s-4)">
          <h4>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 7h3a5 5 0 0 1 5 5 5 5 0 0 1-5 5h-3m-6 0H6a5 5 0 0 1-5-5 5 5 0 0 1 5-5h3"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
            Key '${esc(oneTimeKey.name)}' created. Copy it now.
          </h4>
          <p class="warning">This is the only time the key is shown. After you leave this page it's gone.</p>
          <div class="key-box"><code data-testid="key-cleartext">${esc(oneTimeKey.cleartextKey)}</code></div>
          <div style="margin-top:var(--s-3);display:flex;gap:var(--s-2);justify-content:flex-end">
            <button class="btn ghost" id="s-dismiss-key" data-testid="keys-dismiss-btn">I've copied it</button>
            <button class="btn primary" id="s-copy-key">Copy to clipboard</button>
          </div>
        </div>
      `;
      panel.querySelector('#s-copy-key')?.addEventListener('click', async () => {
        if (!oneTimeKey) return;
        await navigator.clipboard.writeText(oneTimeKey.cleartextKey).catch(() => {});
        const btn = panel.querySelector<HTMLButtonElement>('#s-copy-key');
        if (btn) {
          btn.textContent = 'Copied!';
          setTimeout(() => {
            btn.textContent = 'Copy to clipboard';
          }, 1500);
        }
      });
      panel.querySelector('#s-dismiss-key')?.addEventListener('click', () => {
        oneTimeKey = null;
        void loadKeys(panel);
      });
    }
  }

  tbody.innerHTML = keys.length
    ? keys.map(renderKeyRow).join('')
    : `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted)">No API keys yet. Create one to get started.</td></tr>`;

  panel.querySelectorAll<HTMLButtonElement>('.key-revoke').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.keyId);
      const name = btn.closest<HTMLElement>('tr')?.dataset.name ?? `#${id}`;
      const ok = await confirmDialog({
        title: 'Revoke API key',
        body: `Revoke key '${name}'? Any client using it gets 401 immediately. This cannot be undone.`,
        confirmLabel: 'Revoke',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      const res = await revokeKey(id);
      if (!res.ok) {
        alertDialog({ title: 'Revoke failed', body: `${res.status}` });
        btn.disabled = false;
        return;
      }
      await loadKeys(panel);
    });
  });
}

function openNewKeySlide(panel: HTMLElement): void {
  openSlideover({
    title: 'New API key',
    body: `
      <div class="form-section">
        <div class="sec-head"><span class="ttl">Identification</span></div>
        <div class="field">
          <label>Name</label>
          <input id="so-key-name" data-testid="keys-name-input" placeholder="ci-deploy-bot" required />
          <div class="help">Used in the UI only.</div>
        </div>
      </div>
      <div class="form-section">
        <div class="sec-head"><span class="ttl">Scopes</span></div>
        <div class="choice-row">
          <label class="choice">
            <input type="checkbox" name="so-scope" value="read" />
            <div class="info">
              <div class="ttl"><span class="pill scope read">read</span></div>
              <div class="desc">List monitors, regions, channels and run history.</div>
            </div>
          </label>
          <label class="choice">
            <input type="checkbox" name="so-scope" value="write" checked />
            <div class="info">
              <div class="ttl"><span class="pill scope write">write</span></div>
              <div class="desc">Create, edit and delete monitors. Trigger runs. Includes read.</div>
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
        throw new Error('v');
      }
      if (!scopes.length) {
        errEl.textContent = 'Pick at least one scope.';
        errEl.hidden = false;
        throw new Error('v');
      }
      errEl.hidden = true;
      const { res, data } = await createKey(name, scopes);
      if (!res.ok || 'error' in data) {
        errEl.textContent = ('error' in data ? data.error : null) ?? `Failed (${res.status})`;
        errEl.hidden = false;
        throw new Error('api');
      }
      closeSlideover();
      oneTimeKey = { name: data.name, cleartextKey: data.cleartextKey };
      await loadKeys(panel);
    },
  });
}

function renderKeyRow(k: KeyLite): string {
  const revoked = !!k.revokedAt;
  const heat = heatFor(k.lastUsedAt);
  const status = revoked
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
        ${fmtAge(k.lastUsedAt)}
      </td>
      <td>${status}</td>
      <td class="col-actions">
        ${revoked ? '' : `<button class="btn sm danger key-revoke" data-key-id="${k.id}" data-testid="key-revoke-btn">Revoke</button>`}
      </td>
    </tr>
  `;
}

function heatFor(lastUsed: string | null | undefined): number {
  if (!lastUsed) return 5;
  const hours = (Date.now() - new Date(lastUsed).getTime()) / 3_600_000;
  if (hours < 0.5) return 95;
  if (hours < 2) return 80;
  if (hours < 24) return 60;
  if (hours < 168) return 40;
  return 15;
}
