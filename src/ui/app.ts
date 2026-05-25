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
import { renderRegions } from './regions';
import { renderChannels } from './channels';
import { renderStatusPages } from './status-pages';
import { renderIncidents } from './incidents';
import { renderSettings } from './settings';
import { renderDocs } from './docs-view';
import { initDialogs } from './dialogs';
import { getRegions } from './api';
import { initTheme } from './theme';
import { renderLogin } from './login';
import { renderSetup } from './setup';
import { iconSignOut } from './icons';
import { closeSlideover } from './slideover';

// Track the active view so the background poll can decide what to refresh
// without re-parsing the hash. route() is the single writer; the poll is
// the single reader. Adding a new monitor type only requires updating the
// regex in route() — the poll picks up the change automatically.
type ActiveView =
  | { kind: 'list' }
  | { kind: 'detail'; type: MonType; id: number }
  | { kind: 'section' };
let activeView: ActiveView = { kind: 'list' };

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
  const h = location.hash;
  if (h === '#/regions' || h.startsWith('#/regions/')) {
    activeView = { kind: 'section' };
    setActiveNav('regions');
    renderRegions();
    return;
  }
  if (h === '#/channels' || h.startsWith('#/channels/')) {
    activeView = { kind: 'section' };
    setActiveNav('channels');
    renderChannels();
    return;
  }
  if (h === '#/status-pages' || h.startsWith('#/status-pages/')) {
    activeView = { kind: 'section' };
    setActiveNav('status-pages');
    renderStatusPages();
    return;
  }
  if (h === '#/incidents' || h.startsWith('#/incidents/')) {
    activeView = { kind: 'section' };
    setActiveNav('incidents');
    renderIncidents();
    return;
  }
  if (h === '#/settings') {
    activeView = { kind: 'section' };
    setActiveNav(null);
    renderSettings();
    return;
  }
  if (h === '#/docs' || h.startsWith('#/docs/')) {
    activeView = { kind: 'section' };
    setActiveNav('docs');
    const section = h.startsWith('#/docs/') ? h.slice('#/docs/'.length) : null;
    renderDocs(section);
    return;
  }
  const m = h.match(/^#\/(url|api|qa|tcp|udp|db|tls|heartbeat)\/(\d+)$/);
  if (m) {
    activeView = { kind: 'detail', type: m[1] as MonType, id: Number(m[2]) };
    setActiveNav(null);
    renderDetail(m[1] as MonType, Number(m[2]));
  } else {
    activeView = { kind: 'list' };
    setActiveNav('list');
    renderList();
  }
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
  wireSignOut(state);

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.hidden = false;
    settingsBtn.addEventListener('click', () => {
      location.hash = '#/settings';
    });
  }

  // Show nav and action buttons now that the user is authenticated
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

  window.addEventListener('hashchange', route);

  // Background poll: refresh the active view in place every 5s. route() owns
  // the activeView state, so this branch can never drift out of sync with the
  // router — adding a new monitor type only requires updating the regex above.
  setInterval(() => {
    void refreshRegionBadge();
    if (activeView.kind === 'list') {
      // Don't disrupt keystrokes while the operator is filtering.
      if (document.activeElement?.id === 'search-input') return;
      renderList();
      return;
    }
    if (activeView.kind === 'detail') {
      // Skip if a confirm/alert dialog is open — re-rendering would dismiss
      // it from under the operator. The slideover (Edit, future) is bound
      // to navigation via closeSlideover() in route(), so we don't try to
      // re-render the detail page while one is open either.
      if (document.querySelector('dialog[open]') || document.querySelector('.slideover')) return;
      void renderDetail(activeView.type, activeView.id);
    }
    // section views (regions, channels, status-pages, incidents, settings,
    // docs) intentionally don't auto-refresh; they update on user action.
  }, 5000);
}

boot();
