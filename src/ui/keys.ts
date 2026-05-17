/**
 * API keys settings page — list, create, revoke.
 *
 * Routed under #/keys in app.ts. Mirrors the regions page: the cleartext
 * key returned by create is surfaced exactly once in an inline panel and
 * never stored locally. Revoked keys stay listed (dimmed) as an audit
 * trail — there is no delete.
 */

import { $, esc, fmtAge } from './helpers';
import { getKeys, createKey, revokeKey, type KeyLite, type KeyScope } from './api';
import { confirmDialog, alertDialog } from './dialogs';

interface OneTimeKey {
  name: string;
  cleartextKey: string;
}

let oneTimeKey: OneTimeKey | null = null;

export async function renderKeys() {
  const main = $('#main');
  const keys = await getKeys();
  const active = keys.filter((k) => !k.revokedAt).length;

  main.innerHTML = `
    <div class="regions-page">
      <div class="regions-header">
        <h2>API keys</h2>
        <p class="meta">
          Bearer keys for the CLI, agents and any API consumer
          (<code>Authorization: Bearer oo_…</code>). The dashboard itself uses
          email/password — these are for programmatic access. Revoking is
          immediate and permanent.
        </p>
      </div>

      ${oneTimeKey ? renderOneTimeKey(oneTimeKey) : ''}

      <div class="regions-grid">
        <section class="regions-list">
          <h3>Existing (${active} active / ${keys.length} total)</h3>
          ${keys.length === 0 ? '<p class="meta empty">No keys yet — create one on the right.</p>' : ''}
          ${keys.map(renderKeyRow).join('')}
        </section>

        <section class="regions-create">
          <h3>Create a key</h3>
          <form id="key-create-form">
            <label>Name</label>
            <input name="name" required placeholder="ci-pipeline" />

            <label>Scopes</label>
            <label class="checkbox-label">
              <input type="checkbox" name="scope" value="write" checked />
              write — full read + write (default; what agents/CI need)
            </label>
            <label class="checkbox-label">
              <input type="checkbox" name="scope" value="read" />
              read — read-only endpoints
            </label>

            <div class="dialog-actions">
              <button type="submit" class="primary">Create key</button>
            </div>
            <p id="key-create-error" class="login-error" hidden></p>
          </form>
        </section>
      </div>
    </div>
  `;

  wireKeyRowActions();
  wireCreateForm();
}

function renderKeyRow(k: KeyLite): string {
  const revoked = !!k.revokedAt;
  const dotClass = revoked ? 'offline' : 'online';
  const status = revoked ? `revoked ${fmtAge(k.revokedAt)}` : 'active';
  return `
    <div class="region-row${revoked ? ' revoked' : ''}" data-key-id="${k.id}" data-name="${esc(k.name)}">
      <div class="region-row-main">
        <div class="region-status ${dotClass}" title="${status}"></div>
        <div class="region-info">
          <div class="region-slug"><code>${esc(k.keyPrefix)}…</code></div>
          <div class="region-label">${esc(k.name)} · ${k.scopes.map(esc).join(', ')}</div>
          <div class="meta">${status} · created ${fmtAge(k.createdAt)} · last used ${fmtAge(k.lastUsedAt)}</div>
        </div>
      </div>
      <div class="region-actions">
        ${revoked ? '' : `<button class="key-revoke danger" data-key-id="${k.id}">Revoke</button>`}
      </div>
    </div>
  `;
}

function renderOneTimeKey(otk: OneTimeKey): string {
  return `
    <div class="one-time-key">
      <h3>Key '${esc(otk.name)}' created — copy it now</h3>
      <p class="meta">This is the only time the key is shown. Store it somewhere safe; if you lose it, revoke it and create a new one.</p>
      <pre class="one-time-key-value"><code>${esc(otk.cleartextKey)}</code></pre>
      <div class="dialog-actions">
        <button type="button" id="copy-key-btn">Copy to clipboard</button>
        <button type="button" id="dismiss-key-btn" class="primary">I've copied it</button>
      </div>
    </div>
  `;
}

function wireKeyRowActions() {
  document.querySelectorAll<HTMLButtonElement>('.key-revoke').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.keyId);
      const row = btn.closest<HTMLElement>('.region-row');
      const name = row?.dataset.name ?? `#${id}`;
      const ok = await confirmDialog({
        title: 'Revoke API key',
        body: `Revoke key '${name}'? Any client using it starts getting 401 immediately. This cannot be undone — the row stays listed for audit.`,
        confirmLabel: 'Revoke',
        danger: true,
      });
      if (!ok) return;
      btn.disabled = true;
      const res = await revokeKey(id);
      if (!res.ok) {
        alertDialog({
          title: 'Revoke failed',
          body: `${res.status} ${await res.text().catch(() => '')}`,
        });
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
      setTimeout(() => {
        btn.textContent = 'Copy to clipboard';
      }, 1500);
    } catch {
      // Clipboard may be blocked (non-secure context); the value is still selectable.
    }
  });

  document.getElementById('dismiss-key-btn')?.addEventListener('click', () => {
    oneTimeKey = null;
    renderKeys();
  });
}

function wireCreateForm() {
  const form = document.getElementById('key-create-form') as HTMLFormElement | null;
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get('name') ?? '').trim();
    const scopes = fd.getAll('scope').map(String) as KeyScope[];
    if (!name) return;

    const errEl = document.getElementById('key-create-error') as HTMLElement;
    errEl.hidden = true;
    if (scopes.length === 0) {
      errEl.textContent = 'pick at least one scope';
      errEl.hidden = false;
      return;
    }

    const { res, data } = await createKey(name, scopes);
    if (!res.ok || 'error' in data) {
      errEl.textContent = 'error' in data ? data.error : `request failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    oneTimeKey = { name: data.name, cleartextKey: data.cleartextKey };
    await renderKeys();
  });
}
