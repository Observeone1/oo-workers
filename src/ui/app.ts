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

import { routeAppHash } from './app-routing';
import { initDialogs } from './dialogs';
import { startEventStream, on as onStreamEvent } from './events';
import { getRegions } from './api';
import { initTheme } from './theme';
import { renderLogin } from './login';
import { renderSetup } from './setup';
import { iconSignOut } from './icons';
import { closeSlideover } from './slideover';
import { tickRelativeAges } from './helpers';

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

async function refreshRegionBadge() {
  const badge = document.getElementById('regions-badge');
  if (!badge) return;
  try {
    const regions = await getRegions();
    if (regions.length === 0) {
      badge.hidden = true;
      return;
    }
    const online = regions.filter((r) => r.online).length;
    badge.textContent = `${online}/${regions.length}`;
    badge.classList.toggle('has-online', online > 0);
    badge.hidden = false;
  } catch {
    badge.hidden = true;
  }
}

// Exposed for region admin actions (create/rotate/delete) to nudge the
// badge without waiting for the next 5s tick.
(globalThis as unknown as { ooRefreshRegionBadge?: () => void }).ooRefreshRegionBadge = () => {
  void refreshRegionBadge();
};

function setActiveNav(
  route: 'list' | 'regions' | 'channels' | 'status-pages' | 'incidents' | 'docs' | null,
) {
  document.querySelectorAll<HTMLAnchorElement>('.nav .nav-link').forEach((a) => {
    a.classList.toggle('active', route !== null && a.dataset.route === route);
  });
}

function route() {
  closeSlideover();
  routeAppHash(location.hash, setActiveNav);
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

function wireAuthenticatedApp(state: AuthState): void {
  wireSignOut(state);

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.hidden = false;
    settingsBtn.addEventListener('click', () => {
      location.hash = '#/settings';
    });
  }

  const nav = document.getElementById('nav');
  if (nav) nav.hidden = false;
  const addBtn = document.getElementById('add-btn');
  const importBtn = document.getElementById('import-btn');
  const divider = document.getElementById('header-divider');
  if (addBtn) addBtn.hidden = false;
  if (importBtn) importBtn.hidden = false;
  if (divider) divider.hidden = false;
  initDialogs();
  route();
  void refreshRegionBadge();
  startEventStream();
  onStreamEvent('region', () => void refreshRegionBadge());
  setInterval(() => {
    if (!document.hidden) tickRelativeAges();
  }, 5_000);
  globalThis.addEventListener('hashchange', route);
}

async function boot() {
  initTheme();

  // Check if setup is needed (no users in DB)
  try {
    const setupRes = await fetch('/api/auth/setup-status', { credentials: 'include' });
    if (setupRes.ok) {
      const { needsSetup } = await setupRes.json();
      if (needsSetup) {
        renderSetup();
        return;
      }
    }
  } catch {
    /* network blip — fall through to auth check */
  }

  const { ok, state } = await checkAuth();
  if (!ok || !state) {
    // Hide action buttons on login screen; keep header visible for brand
    const addBtn = document.getElementById('add-btn');
    const importBtn = document.getElementById('import-btn');
    const divider = document.getElementById('header-divider');
    if (addBtn) addBtn.hidden = true;
    if (importBtn) importBtn.hidden = true;
    if (divider) divider.hidden = true;
    renderLogin();
    return;
  }
  wireAuthenticatedApp(state);
}

await boot();
