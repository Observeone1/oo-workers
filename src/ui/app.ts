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
import { startEventStream } from './events';
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

  // Open the SSE stream now that we know the user is authenticated.
  // list.ts subscribes on first renderList(); detail.ts subscribes on
  // first renderDetail(); the stream stays open across hash changes and
  // pauses automatically when the tab is hidden.
  startEventStream();

  window.addEventListener('hashchange', route);

  // Regions badge isn't event-driven yet — region status changes are
  // batched-low-frequency, so a 30s poll is fine until the SSE region
  // emitter lands (follow-up). The 5s polling that previously drove
  // list + detail refresh was deleted with the SSE migration.
  setInterval(() => void refreshRegionBadge(), 30_000);
}

boot();
