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
import { renderDocs } from './docs-view';
import { initDialogs } from './dialogs';
import { getRegions } from './api';
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

function setActiveNav(route: 'list' | 'regions' | 'docs' | null) {
  document.querySelectorAll<HTMLAnchorElement>('.header-nav .nav-link').forEach((a) => {
    a.classList.toggle('active', route !== null && a.dataset.route === route);
  });
}

function route() {
  const h = location.hash;
  if (h === '#/regions' || h.startsWith('#/regions/')) {
    setActiveNav('regions');
    renderRegions();
    return;
  }
  if (h === '#/docs' || h.startsWith('#/docs/')) {
    setActiveNav('docs');
    const section = h.startsWith('#/docs/') ? h.slice('#/docs/'.length) : null;
    renderDocs(section);
    return;
  }
  const m = h.match(/^#\/(url|api|qa|tcp|udp)\/(\d+)$/);
  if (m) {
    setActiveNav(null);
    renderDetail(m[1] as MonType, Number(m[2]));
  } else {
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
  const { ok, state } = await checkAuth();
  if (!ok || !state) {
    // Theme still applies; nothing else (no dialogs, no auto-refresh).
    renderLogin();
    return;
  }
  wireSignOut(state);
  const nav = document.getElementById('header-nav');
  if (nav) nav.hidden = false;
  initDialogs();
  route();
  void refreshRegionBadge();

  window.addEventListener('hashchange', route);

  // Auto-refresh the list every 5s when not viewing a detail page.
  // Skipped while the search input has focus so keystrokes aren't disrupted.
  setInterval(() => {
    void refreshRegionBadge();
    if (
      location.hash.startsWith('#/url/') ||
      location.hash.startsWith('#/api/') ||
      location.hash.startsWith('#/qa/') ||
      location.hash.startsWith('#/tcp/') ||
      location.hash.startsWith('#/udp/') ||
      location.hash.startsWith('#/regions') ||
      location.hash.startsWith('#/docs')
    )
      return;
    if (document.activeElement?.id === 'search-input') return;
    renderList();
  }, 5000);
}

boot();
