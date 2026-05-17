/**
 * First-visit setup — only shown when no users exist in the DB.
 * Creates the first admin account, then redirects into the app.
 */

import { $, esc } from './helpers';

export function renderSetup(opts: { error?: string } = {}) {
  const main = $('#main');
  main.innerHTML = `
    <div class="login-card">
      <h2>Welcome — set up your account</h2>
      <p class="meta">Create the first admin account for this oo-workers instance.</p>
      <form id="setup-form">
        <label>Name</label>
        <input name="name" type="text" autocomplete="name" placeholder="Your name" required />
        <label>Email</label>
        <input name="email" type="email" autocomplete="email" placeholder="you@example.com" required />
        <label>Password</label>
        <input name="password" type="password" autocomplete="new-password" placeholder="Min 8 characters" minlength="8" required />
        ${opts.error ? `<div class="login-error">${esc(opts.error)}</div>` : ''}
        <button type="submit" class="primary">Create account</button>
      </form>
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
