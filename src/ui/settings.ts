/**
 * Settings page — Profile · Security · API keys · Backup & restore.
 * Sidebar rail + single-section content panel. Only the active section renders.
 */

import { $, esc, fmtAge } from './helpers';
import {
  updateProfile,
  changePassword,
  getKeys,
  createKey,
  revokeKey,
  backupUrl,
  backupEstimate,
  restoreBackup,
  type KeyLite,
  type KeyScope,
} from './api';
import { confirmDialog, alertDialog } from './dialogs';
import { openSlideover, closeSlideover } from './slideover';

type SettingsTab = 'profile' | 'security' | 'keys' | 'backup';

interface MeRes {
  name?: string;
  email?: string;
  role?: string;
  prefix?: string;
}
interface OneTimeKey {
  name: string;
  cleartextKey: string;
}

let activeTab: SettingsTab = 'profile';
let oneTimeKey: OneTimeKey | null = null;

const SECTIONS: {
  id: SettingsTab;
  label: string;
  sub: string;
  icon: string;
  hideForApiKey?: boolean;
}[] = [
  {
    id: 'profile',
    label: 'Profile',
    sub: 'Name, email and appearance',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  },
  {
    id: 'security',
    label: 'Security',
    sub: 'Password and active sessions',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    hideForApiKey: true,
  },
  {
    id: 'keys',
    label: 'API keys',
    sub: 'Programmatic + agent access',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="15" r="4"/><path d="m10.85 12.15 9.15-9.15M18 5l3 3M15 8l3 3"/></svg>',
  },
  {
    id: 'backup',
    label: 'Backup & restore',
    sub: 'Export config · roll back',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
  },
];

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function renderSettings(tab?: SettingsTab) {
  if (tab) activeTab = tab;

  const main = $('#main');
  const meRes: MeRes = await fetch('/api/auth/me', { credentials: 'include' })
    .then((r) => r.json())
    .catch(() => ({}));
  const isApiKey = !!meRes.prefix;

  const initials = getInitials(meRes.name ?? meRes.email ?? '?');
  const visibleSections = SECTIONS.filter((s) => !(isApiKey && s.hideForApiKey));

  // If active tab got hidden (e.g. password when using API key), fall back
  if (!visibleSections.find((s) => s.id === activeTab)) activeTab = 'profile';

  const rail = visibleSections
    .map(
      (s) => `
    <button class="set-step${s.id === activeTab ? ' active' : ''}" data-section="${s.id}" data-testid="settings-tab-${s.id}">
      <span class="ico">${s.icon}</span>
      <span class="lbl">
        <span class="t">${s.label}</span>
        <span class="d">${s.sub}</span>
      </span>
    </button>
  `,
    )
    .join('');

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h2>Settings</h2>
        <div class="sub">Manage your account, security and instance data.</div>
      </div>
      <div class="row-flex" style="gap:8px">
        ${meRes.role ? `<span class="pill${meRes.role === 'admin' ? ' up' : ''}">${esc(meRes.role)}</span>` : ''}
      </div>
    </div>

    <div class="settings-layout">
      <aside class="settings-rail">
        <div class="set-id">
          <span class="avatar">${esc(initials)}</span>
          <span class="who">
            <span class="n">${esc(meRes.name ?? '—')}</span>
            <span class="e">${esc(meRes.email ?? '')}</span>
          </span>
        </div>
        <nav class="set-nav">${rail}</nav>
        <div class="set-foot">
          <div class="k">Instance</div>
          <div class="v mono">oo-workers</div>
          <div class="k" style="margin-top:8px">License</div>
          <div class="v mono">self-host · Apache-2.0</div>
        </div>
      </aside>
      <section class="settings-content" id="settings-content"></section>
    </div>
  `;

  document.querySelectorAll<HTMLButtonElement>('.set-step').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.section as SettingsTab;
      document.querySelectorAll('.set-step').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      void renderPanel(meRes, initials);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  await renderPanel(meRes, initials);
}

async function renderPanel(meRes: MeRes, initials: string) {
  const panel = document.getElementById('settings-content');
  if (!panel) return;
  switch (activeTab) {
    case 'profile':
      return renderProfile(panel, meRes, initials);
    case 'security':
      return renderSecurity(panel);
    case 'keys':
      return renderKeys(panel);
    case 'backup':
      return renderBackup(panel);
  }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  const mb = n / (1024 * 1024);
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

// ─── Profile ─────────────────────────────────────────────────────────────────

function renderProfile(panel: HTMLElement, meRes: MeRes, initials: string) {
  const storedTheme = localStorage.getItem('oo-workers:theme') ?? 'system';
  const storedAccent = localStorage.getItem('oo-workers:accent') ?? '#10b981';
  const ACCENTS = ['#10b981', '#22d3ee', '#8b5cf6', '#f59e0b', '#f43f5e'];

  panel.innerHTML = `
    <div class="set-section-head">
      <div>
        <h3>Profile</h3>
        <p class="sub">How you appear in audit logs and alert payloads.</p>
      </div>
      <button class="btn primary" id="s-profile-save">Save changes</button>
    </div>

    <div class="set-card">
      <div class="form-section" style="border:none;padding:0;margin:0">
        <div class="sec-head"><span class="ttl">Identity</span></div>
        <div class="profile-row">
          <div class="avatar-stack">
            <div class="avatar-lg">${esc(initials)}</div>
          </div>
          <div class="field-grid cols-2" style="flex:1;min-width:0">
            <div class="field">
              <label>Display name</label>
              <input id="s-name" value="${esc(meRes.name ?? '')}" placeholder="Your name" />
              <div class="help">Shown in the UI and in alert payloads.</div>
            </div>
            <div class="field">
              <label>Email</label>
              <input id="s-email" type="email" value="${esc(meRes.email ?? '')}" placeholder="you@example.com" />
              <div class="help">Used for sign-in and password recovery.</div>
            </div>
            ${
              meRes.role
                ? `
            <div class="field">
              <label>Role</label>
              <input value="${esc(meRes.role)}" readonly style="color:var(--muted);cursor:default" />
              <div class="help">Contact an admin to change your role.</div>
            </div>`
                : ''
            }
          </div>
        </div>
      </div>

      <hr/>

      <div class="form-section" style="border:none;padding:0;margin:0">
        <div class="sec-head"><span class="ttl">Appearance</span><span class="opt">applies to this browser only</span></div>
        <div class="field-grid cols-2">
          <div class="field">
            <label>Theme</label>
            <div class="seg-inline" id="set-theme">
              <button data-val="system" class="seg-btn${storedTheme === 'system' || storedTheme === '' ? ' on' : ''}">System</button>
              <button data-val="light"  class="seg-btn${storedTheme === 'light' ? ' on' : ''}">Light</button>
              <button data-val="dark"   class="seg-btn${storedTheme === 'dark' ? ' on' : ''}">Dark</button>
            </div>
          </div>
        </div>
        <div class="field" style="margin-top:var(--s-3)">
          <label>Accent color</label>
          <div class="set-swatches" id="set-accent">
            ${ACCENTS.map(
              (c) => `
              <button class="sw sw-btn${storedAccent === c ? ' on' : ''}" style="--sw:${c}" data-val="${c}" title="${c}"></button>
            `,
            ).join('')}
          </div>
        </div>
      </div>

      <p id="s-profile-err" class="banner err" hidden></p>
      <p id="s-profile-ok"  class="banner ok"  hidden>Profile updated.</p>
    </div>
  `;

  // Theme segmented control
  document.querySelectorAll<HTMLButtonElement>('#set-theme button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#set-theme button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      const val = btn.dataset.val!;
      if (val === 'system') {
        localStorage.removeItem('oo-workers:theme');
        document.documentElement.style.colorScheme = '';
      } else {
        localStorage.setItem('oo-workers:theme', val);
        document.documentElement.style.colorScheme = val;
        document.documentElement.dataset.theme = val;
      }
    });
  });

  // Accent swatches
  document.querySelectorAll<HTMLButtonElement>('#set-accent .sw').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#set-accent .sw').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      const color = btn.dataset.val!;
      localStorage.setItem('oo-workers:accent', color);
      document.documentElement.style.setProperty('--accent', color);
    });
  });

  // Save profile
  document.getElementById('s-profile-save')?.addEventListener('click', async () => {
    const name = $<HTMLInputElement>('#s-name').value.trim();
    const email = $<HTMLInputElement>('#s-email').value.trim();
    const errEl = $<HTMLElement>('#s-profile-err');
    const okEl = $<HTMLElement>('#s-profile-ok');
    errEl.hidden = true;
    okEl.hidden = true;
    if (!name || !email) {
      errEl.textContent = 'Name and email are required.';
      errEl.hidden = false;
      return;
    }
    const { res, data } = await updateProfile(name, email);
    if (!res.ok || 'error' in data) {
      errEl.textContent = ('error' in data ? data.error : null) ?? `Failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    okEl.hidden = false;
    setTimeout(() => {
      okEl.hidden = true;
    }, 3000);
  });
}

// ─── Security ────────────────────────────────────────────────────────────────

function renderSecurity(panel: HTMLElement) {
  panel.innerHTML = `
    <div class="set-section-head">
      <div>
        <h3>Security</h3>
        <p class="sub">Password and signed-in sessions.</p>
      </div>
    </div>

    <div class="set-card">
      <div class="form-section" style="border:none;padding:0;margin:0">
        <div class="sec-head"><span class="ttl">Change password</span></div>

        <div class="field-grid" style="grid-template-columns:1fr">
          <div class="field">
            <label>Current password</label>
            <div class="input-addon pw">
              <input type="password" id="pw-cur" placeholder="••••••••••••" autocomplete="current-password" />
              <button class="suffix-btn" data-toggle-pw="pw-cur" type="button" aria-label="Show">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
          </div>
        </div>

        <div class="field-grid cols-2">
          <div class="field">
            <label>New password</label>
            <div class="input-addon pw">
              <input type="password" id="pw-new" placeholder="8+ characters" autocomplete="new-password" />
              <button class="suffix-btn" data-toggle-pw="pw-new" type="button" aria-label="Show">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
            <div class="pw-meter" id="pw-meter">
              <span class="bar"></span><span class="bar"></span>
              <span class="bar"></span><span class="bar"></span>
            </div>
            <div class="help" id="pw-hint">Use 8+ characters.</div>
          </div>
          <div class="field">
            <label>Confirm new password</label>
            <div class="input-addon pw">
              <input type="password" id="pw-cfm" placeholder="re-type new password" autocomplete="new-password" />
              <button class="suffix-btn" data-toggle-pw="pw-cfm" type="button" aria-label="Show">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>
              </button>
            </div>
            <div class="help" id="pw-cfm-hint" style="opacity:0">&nbsp;</div>
          </div>
        </div>

        <p id="s-pw-err" class="banner err" hidden></p>
        <p id="s-pw-ok"  class="banner ok"  hidden>Password updated successfully.</p>

        <div class="row-flex" style="justify-content:flex-end;gap:8px;margin-top:var(--s-3)">
          <button class="btn" id="s-pw-reset">Reset fields</button>
          <button class="btn primary" id="s-pw-save">Update password</button>
        </div>
      </div>

      <hr/>

      <div class="form-section" style="border:none;padding:0;margin:0">
        <div class="sec-head"><span class="ttl">Sessions</span></div>
        <div class="session-list">
          <div class="session-row me">
            <div class="dot up"></div>
            <div class="info">
              <div class="title">
                ${esc(navigator.userAgent.includes('Chrome') ? 'Chrome' : navigator.userAgent.includes('Safari') ? 'Safari' : 'Browser')}
                <span class="pill up">this device</span>
              </div>
              <div class="meta">current session</div>
            </div>
          </div>
        </div>
        <p class="help" style="margin-top:var(--s-2)">Session management across devices will be available in a future release.</p>
      </div>
    </div>
  `;

  // Show/hide password
  panel.querySelectorAll<HTMLButtonElement>('[data-toggle-pw]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = panel.querySelector<HTMLInputElement>('#' + btn.dataset.togglePw);
      if (!input) return;
      input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  // Password strength meter
  const pwNew = panel.querySelector<HTMLInputElement>('#pw-new');
  if (pwNew) pwNew.addEventListener('input', () => updatePwMeter(pwNew.value, panel));

  // Confirm match
  const pwCfm = panel.querySelector<HTMLInputElement>('#pw-cfm');
  const cfmHint = panel.querySelector<HTMLElement>('#pw-cfm-hint');
  if (pwCfm && cfmHint) {
    pwCfm.addEventListener('input', () => {
      if (!pwCfm.value) {
        cfmHint.style.opacity = '0';
        cfmHint.textContent = '\xa0';
        return;
      }
      const match = pwNew?.value === pwCfm.value;
      cfmHint.style.opacity = '1';
      cfmHint.style.color = match ? 'var(--up-text)' : 'var(--down-text)';
      cfmHint.textContent = match ? '✓ passwords match' : '✗ passwords do not match';
    });
  }

  // Reset
  panel.querySelector('#s-pw-reset')?.addEventListener('click', () => {
    ['pw-cur', 'pw-new', 'pw-cfm'].forEach((id) => {
      const el = panel.querySelector<HTMLInputElement>('#' + id);
      if (el) el.value = '';
    });
    updatePwMeter('', panel);
    const cfmH = panel.querySelector<HTMLElement>('#pw-cfm-hint');
    if (cfmH) {
      cfmH.style.opacity = '0';
      cfmH.textContent = '\xa0';
    }
  });

  // Save
  panel.querySelector('#s-pw-save')?.addEventListener('click', async () => {
    const cur = panel.querySelector<HTMLInputElement>('#pw-cur')!.value;
    const next = panel.querySelector<HTMLInputElement>('#pw-new')!.value;
    const cfm = panel.querySelector<HTMLInputElement>('#pw-cfm')!.value;
    const errEl = panel.querySelector<HTMLElement>('#s-pw-err')!;
    const okEl = panel.querySelector<HTMLElement>('#s-pw-ok')!;
    errEl.hidden = true;
    okEl.hidden = true;
    if (!cur || !next) {
      errEl.textContent = 'All fields are required.';
      errEl.hidden = false;
      return;
    }
    if (next !== cfm) {
      errEl.textContent = 'New passwords do not match.';
      errEl.hidden = false;
      return;
    }
    if (next.length < 8) {
      errEl.textContent = 'New password must be at least 8 characters.';
      errEl.hidden = false;
      return;
    }
    const { res, data } = await changePassword(cur, next);
    if (!res.ok || 'error' in data) {
      errEl.textContent = ('error' in data ? data.error : null) ?? `Failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    ['pw-cur', 'pw-new', 'pw-cfm'].forEach((id) => {
      const el = panel.querySelector<HTMLInputElement>('#' + id);
      if (el) el.value = '';
    });
    updatePwMeter('', panel);
    okEl.hidden = false;
    setTimeout(() => {
      okEl.hidden = true;
    }, 4000);
  });
}

function updatePwMeter(v: string, panel: HTMLElement) {
  const meter = panel.querySelector<HTMLElement>('#pw-meter');
  const hint = panel.querySelector<HTMLElement>('#pw-hint');
  if (!meter) return;
  let score = 0;
  if (v.length >= 8) score++;
  if (v.length >= 12) score++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
  if (/[0-9]/.test(v) && /[^A-Za-z0-9]/.test(v)) score++;
  const colors = ['var(--down)', 'var(--down)', 'var(--warn)', 'var(--info)', 'var(--up)'];
  const labels = ['too short', 'weak', 'fair', 'good', 'strong'];
  meter.querySelectorAll<HTMLElement>('.bar').forEach((b, i) => {
    b.style.background = i < score ? colors[score] : 'var(--panel-2)';
  });
  if (hint) {
    hint.textContent = v.length === 0 ? 'Use 8+ characters.' : `Strength: ${labels[score]}`;
    hint.style.color = v.length === 0 ? '' : colors[score];
  }
}

// ─── API Keys ────────────────────────────────────────────────────────────────

async function renderKeys(panel: HTMLElement) {
  panel.innerHTML = `
    <div class="set-section-head">
      <div>
        <h3>API keys</h3>
        <p class="sub">Programmatic access to the oo-workers API.</p>
      </div>
      <button class="btn primary" id="s-add-key">
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

async function loadKeys(panel: HTMLElement) {
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
            Key '${esc(oneTimeKey.name)}' created — copy it now
          </h4>
          <p class="warning">This is the only time the key is shown. After you leave this page it's gone.</p>
          <div class="key-box"><code>${esc(oneTimeKey.cleartextKey)}</code></div>
          <div style="margin-top:var(--s-3);display:flex;gap:var(--s-2);justify-content:flex-end">
            <button class="btn" id="s-copy-key">Copy to clipboard</button>
            <button class="btn primary" id="s-dismiss-key">I've copied it</button>
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

function openNewKeySlide(panel: HTMLElement) {
  openSlideover({
    title: 'New API key',
    body: `
      <div class="form-section">
        <div class="sec-head"><span class="ttl">Identification</span></div>
        <div class="field">
          <label>Name</label>
          <input id="so-key-name" placeholder="ci-deploy-bot" required />
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
        ${revoked ? '' : `<button class="btn sm danger key-revoke" data-key-id="${k.id}">Revoke</button>`}
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

// ─── Backup & Restore ────────────────────────────────────────────────────────

function renderBackup(panel: HTMLElement) {
  panel.innerHTML = `
    <div class="set-section-head">
      <div>
        <h3>Backup &amp; restore</h3>
        <p class="sub">Export your monitors, channels, regions and status pages. Restore from an earlier snapshot.</p>
      </div>
    </div>

    <div class="backup-hero">
      <div class="cell">
        <div class="k">Download scope</div>
        <div class="v">Config + history</div>
        <div class="sub">last 90 days of runs</div>
      </div>
      <div class="cell">
        <div class="k">Format</div>
        <div class="v">.tar.gz</div>
        <div class="sub">gzipped JSON dump</div>
      </div>
    </div>

    <div class="set-card">
      <div class="form-section" style="border:none;padding:0;margin:0">
        <div class="sec-head"><span class="ttl">Download backup</span></div>
        <p class="help" style="margin-bottom:var(--s-3)">Full logical dump of config + execution history. Restore replaces <strong>all</strong> data.</p>
        <div class="field">
          <label>History window</label>
          <div class="seg-inline" id="s-scope-seg">
            <button data-val="window" data-testid="backup-scope-window" class="seg-btn on">Last 90 days</button>
            <button data-val="all" data-testid="backup-scope-all" class="seg-btn">All history</button>
            <button data-val="none" data-testid="backup-scope-none" class="seg-btn">Config only</button>
          </div>
        </div>
        <div class="field" style="margin-top:var(--s-3)">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
            <input type="checkbox" id="s-include-artifacts" data-testid="backup-include-artifacts" checked />
            <span>Include browser run artifacts <span id="s-artifacts-estimate" class="opt"></span></span>
          </label>
          <p class="help" style="margin-top:6px">QA test scripts and Playwright trace/screenshot files for failed browser runs. Without these, a restored host has dangling references.</p>
        </div>
        <div style="margin-top:var(--s-4);display:flex;justify-content:flex-end">
          <button class="btn primary" id="s-backup-download" data-testid="backup-download-btn">
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download
          </button>
        </div>
      </div>
    </div>

    <div class="set-card">
      <div class="form-section" style="border:none;padding:0;margin:0">
        <div class="sec-head"><span class="ttl">Restore from file</span><span class="opt">accepts .tar.gz</span></div>
        <label class="drop-zone" id="s-drop-zone">
          <div class="ico">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5-5 5 5M12 5v15"/></svg>
          </div>
          <div class="t">Drop a backup file here or <span class="link-look">browse</span></div>
          <div class="d mono">.tar.gz · up to 50 MB</div>
          <input type="file" id="s-backup-file" accept=".gz,application/gzip" hidden />
        </label>
        <p class="help" style="margin-top:8px">A restore wipes all current monitors, channels, regions and status pages and replaces them with the backup. This cannot be undone.</p>
        <p id="s-restore-err" class="banner err" hidden></p>
        <div style="margin-top:var(--s-3);display:flex;justify-content:flex-end">
          <button class="btn danger" id="s-backup-restore">Restore from file</button>
        </div>
      </div>
    </div>
  `;

  // Scope segmented control
  panel.querySelectorAll<HTMLButtonElement>('#s-scope-seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      panel.querySelectorAll('#s-scope-seg button').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
    });
  });

  // Artifacts estimate — fetch once on mount; tag onto the checkbox label.
  // No warning threshold: just show the count + size next to the label.
  const estimateEl = panel.querySelector<HTMLElement>('#s-artifacts-estimate');
  const artifactsBox = panel.querySelector<HTMLInputElement>('#s-include-artifacts');
  if (estimateEl) {
    void backupEstimate().then((est) => {
      if (est.artifactCount === 0) {
        estimateEl.textContent = '(no artifacts yet)';
        return;
      }
      const size = formatBytes(est.artifactBytes);
      estimateEl.textContent = `(~${est.artifactCount} object${est.artifactCount === 1 ? '' : 's'}, ${size})`;
    });
  }

  // Download
  panel.querySelector('#s-backup-download')?.addEventListener('click', () => {
    const scope =
      panel.querySelector<HTMLButtonElement>('#s-scope-seg button.on')?.dataset.val ?? 'window';
    const includeArtifacts = artifactsBox?.checked ?? true;
    const a = document.createElement('a');
    a.href = backupUrl(scope, 90, includeArtifacts);
    a.click();
  });

  // Drop zone
  const drop = panel.querySelector<HTMLElement>('#s-drop-zone');
  if (drop) {
    ['dragenter', 'dragover'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.add('over');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      drop.addEventListener(ev, (e) => {
        e.preventDefault();
        drop.classList.remove('over');
      }),
    );
  }

  // Restore
  panel.querySelector('#s-backup-restore')?.addEventListener('click', async () => {
    const input = panel.querySelector<HTMLInputElement>('#s-backup-file')!;
    const file = input.files?.[0];
    const errEl = panel.querySelector<HTMLElement>('#s-restore-err')!;
    errEl.hidden = true;
    if (!file) {
      errEl.textContent = 'Select a backup file first.';
      errEl.hidden = false;
      return;
    }
    const ok = await confirmDialog({
      title: 'Restore from backup',
      body: `Restoring "${file.name}" wipes every monitor, channel, and execution and replaces them with the backup. This cannot be undone.`,
      confirmLabel: 'Wipe and restore',
      danger: true,
    });
    if (!ok) return;
    const { res, result } = await restoreBackup(file, true);
    if (!res.ok) {
      errEl.textContent = result.error ?? `Restore failed (${res.status})`;
      errEl.hidden = false;
      return;
    }
    const total = Object.values(result.counts ?? {}).reduce(
      (a: number, b: unknown) => a + (b as number),
      0,
    );
    alertDialog({ title: 'Restore complete', body: `${total} rows restored.` });
  });

  // File input trigger on click (browse)
  const fileInput = panel.querySelector<HTMLInputElement>('#s-backup-file');
  drop?.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('input[type="file"]')) return;
    fileInput?.click();
  });
}
