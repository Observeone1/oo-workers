/**
 * Single-page UI entrypoint. Hash-based routing:
 *   #/            → monitor list
 *   #/<type>/<id> → monitor detail
 *
 * Module boundaries:
 *   types.ts    — shared TS types
 *   helpers.ts  — pure DOM + format helpers
 *   api.ts      — typed fetch wrappers
 *   list.ts     — list view (renderList + row rendering)
 *   detail.ts   — detail view (renderDetail + sparkline)
 *   dialogs.ts  — Add / Import dialog wiring
 */

import type { MonType } from './types';
import { renderList } from './list';
import { renderDetail } from './detail';
import { initDialogs } from './dialogs';
import { initTheme } from './theme';
import { renderLogin } from './login';
import { iconSignOut } from './icons';

interface AuthState {
  name: string;
  prefix: string;
  scopes: string[];
}

async function checkAuth(): Promise<{ ok: boolean; state?: AuthState }> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.status === 401) return { ok: false };
    return { ok: true, state: await res.json() };
  } catch {
    // Network blip — render login so the user retries instead of seeing a blank app.
    return { ok: false };
  }
}

function route() {
  const h = location.hash;
  const m = h.match(/^#\/(url|api|qa|tcp|udp)\/(\d+)$/);
  if (m) renderDetail(m[1] as MonType, Number(m[2]));
  else renderList();
}

function wireSignOut(state: AuthState) {
  const btn = document.getElementById('sign-out') as HTMLButtonElement | null;
  if (!btn) return;
  btn.hidden = false;
  btn.innerHTML = iconSignOut;
  btn.title = `Signed in as ${state.name} — click to sign out`;
  btn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    location.reload();
  });
}

async function boot() {
  initTheme();
  const { ok, state } = await checkAuth();
  if (!ok || !state) {
    // Theme still applies; nothing else (no dialogs, no auto-refresh).
    renderLogin();
    return;
  }
  wireSignOut(state);
  initDialogs();
  route();

  window.addEventListener('hashchange', route);

  // Auto-refresh the list every 5s when not viewing a detail page.
  // Skipped while the search input has focus so keystrokes aren't disrupted.
  setInterval(() => {
    if (
      location.hash.startsWith('#/url/') ||
      location.hash.startsWith('#/api/') ||
      location.hash.startsWith('#/qa/') ||
      location.hash.startsWith('#/tcp/') ||
      location.hash.startsWith('#/udp/')
    )
      return;
    if (document.activeElement?.id === 'search-input') return;
    renderList();
  }, 5000);
}

boot();
