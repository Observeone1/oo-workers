/**
 * First-visit setup — only shown when no users exist in the DB.
 * Creates the first admin account, then redirects into the app.
 */

import { $, esc } from './helpers';

export function renderSetup(opts: { error?: string } = {}) {
  // Hide header on setup
  const header = document.getElementById('app-header');
  if (header) header.hidden = true;

  const main = $('#main');
  main.innerHTML = `
    <div class="auth-shell">
      <div class="auth-stage">
        <div class="auth-brand">
          <span class="brand-mark" aria-hidden="true"></span>
          oo-workers
          <span class="brand-tag">self-host</span>
        </div>
        <p class="auth-headline">Welcome to<br/>your <em>own instance</em></p>
        <p class="auth-sub">Create the first admin account to get started. You'll be able to add monitors, regions, and alert channels right after.</p>
        <div class="auth-terminal">
          <div class="bar">
            <div class="dots"><i></i><i></i><i></i></div>
            <span class="ttl">oo-workers · setup</span>
            <span class="live"><span class="dot up"></span>ready</span>
          </div>
          <div class="log">
            <div class="scroll">
              <span class="line"><span class="t">setup</span>  <span class="ok">✓</span>  <span class="target">database migrations complete</span></span>
              <span class="line"><span class="t">setup</span>  <span class="ok">✓</span>  <span class="target">worker engine started</span></span>
              <span class="line"><span class="t">setup</span>  <span class="ok">✓</span>  <span class="target">API server listening on :3000</span></span>
              <span class="line"><span class="t">setup</span>  <span class="reg">›</span>  <span class="target">waiting for first admin account…</span></span>
              <span class="line"><span class="t">setup</span>  <span class="ok">✓</span>  <span class="target">database migrations complete</span></span>
              <span class="line"><span class="t">setup</span>  <span class="ok">✓</span>  <span class="target">worker engine started</span></span>
              <span class="line"><span class="t">setup</span>  <span class="ok">✓</span>  <span class="target">API server listening on :3000</span></span>
              <span class="line"><span class="t">setup</span>  <span class="reg">›</span>  <span class="target">waiting for first admin account…</span></span>
            </div>
          </div>
        </div>
      </div>
      <div class="auth-form-wrap">
        <div class="auth-card">
          <p class="lead">Create your account</p>
          <p class="lead-sub">Set up the first admin for this oo-workers instance.</p>
          <form id="setup-form">
            <div class="auth-field">
              <label>Name</label>
              <input name="name" type="text" autocomplete="name" placeholder="Your name" required />
            </div>
            <div class="auth-field">
              <label>Email</label>
              <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required />
            </div>
            <div class="auth-field">
              <label>Password</label>
              <input name="password" type="password" autocomplete="new-password" placeholder="Min 8 characters" minlength="8" required />
            </div>
            ${opts.error ? `<div class="banner err" style="margin-bottom:12px">${esc(opts.error)}</div>` : ''}
            <button type="submit" class="btn primary submit">
              Create account
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

  const form = document.getElementById('setup-form') as HTMLFormElement;
  const nameInput = form.querySelector('input[name="name"]') as HTMLInputElement;
  nameInput.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (form.querySelector('input[name="name"]') as HTMLInputElement).value.trim();
    const email = (form.querySelector('input[name="email"]') as HTMLInputElement).value.trim();
    const password = (form.querySelector('input[name="password"]') as HTMLInputElement).value;
    if (!name || !email || !password) return;

    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, email, password }),
    });
    if (res.ok) {
      location.reload();
      return;
    }
    let msg = 'Setup failed';
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* keep default */
    }
    renderSetup({ error: msg });
  });
}
