/**
 * Login screen — renders into #main when /api/auth/me returns 401.
 * Email + password form. POST /api/auth/login, server sets the HttpOnly
 * session cookie, page reloads into the normal app.
 */

import { $, esc } from './helpers';

export function renderLogin(opts: { error?: string } = {}) {
  const addBtn = document.getElementById('add-btn');
  const importBtn = document.getElementById('import-btn');
  const divider = document.querySelector<HTMLElement>('.header-divider');
  if (addBtn) addBtn.hidden = true;
  if (importBtn) importBtn.hidden = true;
  if (divider) divider.hidden = true;

  const main = $('#main');
  main.innerHTML = `
    <div class="login-card">
      <h2>Sign in</h2>
      <p class="meta">Enter your email and password.</p>
      <form id="login-form">
        <label>Email</label>
        <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required />
        <label>Password</label>
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" required />
        ${opts.error ? `<div class="login-error">${esc(opts.error)}</div>` : ''}
        <button type="submit" class="primary">Sign in</button>
      </form>
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
