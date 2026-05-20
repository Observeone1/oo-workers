/**
 * Login screen — renders into #main when /api/auth/me returns 401.
 * Email + password form. POST /api/auth/login, server sets the HttpOnly
 * session cookie, page reloads into the normal app.
 */

import { $, esc } from './helpers';

const TERMINAL_LINES = [
  ['t', '17:42:01', 'ok', 'https://api.acme.com/v1/health', 'us-east-1', '142ms'],
  ['t', '17:42:01', 'ok', 'https://checkout.acme.com', 'eu-west-1', '89ms'],
  ['t', '17:42:02', 'ok', 'https://auth.acme.com/oauth/token', 'ap-south-1', '201ms'],
  ['t', '17:42:03', 'ok', 'smtp.acme.com:587', 'us-east-1', '44ms'],
  ['t', '17:42:04', 'ok', 'https://api.acme.com/v2/status', 'eu-west-1', '118ms'],
  ['t', '17:42:05', 'ok', 'https://cdn.acme.com/health', 'us-west-2', '67ms'],
  ['t', '17:42:06', 'ok', 'https://ws.acme.com/ping', 'ap-south-1', '310ms'],
  ['t', '17:42:07', 'ok', 'https://dashboard.acme.com', 'us-east-1', '95ms'],
  ['t', '17:42:08', 'ok', 'https://api.acme.com/v1/health', 'eu-west-1', '137ms'],
  ['t', '17:42:09', 'ok', 'https://auth.acme.com/oauth/token', 'us-east-1', '188ms'],
  ['t', '17:42:10', 'ok', 'https://checkout.acme.com', 'us-west-2', '102ms'],
  ['t', '17:42:11', 'ok', 'https://api.acme.com/v2/status', 'us-east-1', '121ms'],
];

function terminalLines(): string {
  return TERMINAL_LINES.map(
    ([, time, status, target, region, lat]) =>
      `<span class="line"><span class="t">${time}</span>  <span class="${status}">${status === 'ok' ? '✓' : '✗'}</span>  <span class="target">${esc(target ?? '')}</span>  <span class="arrow">@</span>  <span class="reg">${esc(region ?? '')}</span>  <span class="lat">${esc(lat ?? '')}</span></span>`,
  ).join('');
}

export function renderLogin(opts: { error?: string } = {}) {
  // Hide header on login
  const header = document.getElementById('app-header');
  if (header) header.hidden = true;

  const main = $('#main');
  main.innerHTML = `
    <div class="auth-shell" data-testid="login-shell">
      <div class="auth-stage">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true"></span>
          oo-workers
          <span class="brand-tag">self-host</span>
        </div>
        <p class="auth-headline">Open-source uptime<br/>monitoring — <em>yours to run</em></p>
        <p class="auth-sub">Self-hosted agents, multi-region probing, Playwright browser checks, and instant alerts. No SaaS dependencies.</p>
        <div class="auth-terminal">
          <div class="bar">
            <div class="dots"><i></i><i></i><i></i></div>
            <span class="ttl">oo-workers · live runs</span>
            <span class="live"><span class="dot up"></span>streaming</span>
          </div>
          <div class="log">
            <div class="scroll">${terminalLines()}${terminalLines()}</div>
          </div>
        </div>
        <div class="auth-instance">
          <div class="cell"><div class="k">Monitors</div><div class="v">—</div></div>
          <div class="cell"><div class="k">Regions</div><div class="v">—</div></div>
          <div class="cell"><div class="k">Uptime</div><div class="v">—<span class="u">%</span></div></div>
        </div>
      </div>
      <div class="auth-form-wrap">
        <div class="auth-card">
          <p class="lead">Sign in</p>
          <p class="lead-sub">Enter your credentials to access the dashboard.</p>
          <form id="login-form">
            <div class="auth-field">
              <label>Email</label>
              <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required />
            </div>
            <div class="auth-field">
              <label>Password</label>
              <input name="password" type="password" autocomplete="current-password" placeholder="Password" required />
            </div>
            ${opts.error ? `<div class="banner err" style="margin-bottom:12px">${esc(opts.error)}</div>` : ''}
            <button type="submit" class="btn primary submit">
              Sign in
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </form>
          <div class="auth-foot">
            <span>oo-workers</span>
            <span class="spacer"></span>
            <span class="ver">self-host</span>
          </div>
        </div>
      </div>
    </div>
  `;

  const form = document.getElementById('login-form') as HTMLFormElement;
  const emailInput = form.querySelector('input[name="email"]') as HTMLInputElement;
  emailInput.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = (form.querySelector('input[name="email"]') as HTMLInputElement).value.trim();
    const password = (form.querySelector('input[name="password"]') as HTMLInputElement).value;
    if (!email || !password) return;

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    if (res.ok) {
      location.reload();
      return;
    }
    let msg = 'Sign-in failed';
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* keep default */
    }
    renderLogin({ error: msg });
  });
}
