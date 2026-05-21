/**
 * Settings → Security section. Password change with a 4-bar strength
 * meter + confirm-match feedback. Sessions are stubbed (current device
 * only) until multi-session listing lands.
 */
import { esc } from '../helpers';
import { changePassword } from '../api';

export function renderSecurity(panel: HTMLElement): void {
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

function updatePwMeter(v: string, panel: HTMLElement): void {
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
