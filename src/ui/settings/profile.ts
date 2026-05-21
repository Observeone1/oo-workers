/**
 * Settings → Profile section. Display name + email + appearance
 * (theme + accent). Theme/accent persist to localStorage and apply
 * immediately to the document root.
 */
import { $, esc } from '../helpers';
import { updateProfile } from '../api';

export interface ProfileMe {
  name?: string;
  email?: string;
  role?: string;
  prefix?: string;
}

export function renderProfile(panel: HTMLElement, meRes: ProfileMe, initials: string): void {
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
