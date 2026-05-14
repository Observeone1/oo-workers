/**
 * Login screen — renders into #main when /api/auth/me returns 401.
 * Single input, POST /api/auth/login with the cleartext key,
 * server sets the HttpOnly cookie, page reloads into the normal app.
 */

import { $, esc } from './helpers';

export function renderLogin(opts: { error?: string } = {}) {
  // Hide the header write-actions while unauth'd — they 401 if clicked.
  // The theme toggle stays visible so dark/light still works pre-login.
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
      <p class="meta">
        Paste your API key to access this oo-workers stack. Run
        <code>docker compose exec worker bun scripts/create-api-key.ts --name first</code>
        on the host to generate one.
      </p>
      <form id="login-form">
        <label>API key</label>
        <input
          name="key"
          type="password"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          placeholder="oo_..."
          required
        />
        ${opts.error ? `<div class="login-error">${esc(opts.error)}</div>` : ''}
        <button type="submit" class="primary">Sign in</button>
      </form>
    </div>
  `;

  const form = document.getElementById('login-form') as HTMLFormElement;
  const input = form.querySelector('input[name="key"]') as HTMLInputElement;
  input.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = input.value.trim();
    if (!key) return;
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      // Cookie is set; reload triggers the normal route() path.
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
