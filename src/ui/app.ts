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

function route() {
  const h = location.hash;
  const m = h.match(/^#\/(url|api|qa|tcp)\/(\d+)$/);
  if (m) renderDetail(m[1] as MonType, Number(m[2]));
  else renderList();
}

window.addEventListener('hashchange', route);

// Auto-refresh the list every 5s when not viewing a detail page.
// Skipped while the search input has focus so keystrokes aren't disrupted.
setInterval(() => {
  if (
    location.hash.startsWith('#/url/') ||
    location.hash.startsWith('#/api/') ||
    location.hash.startsWith('#/qa/') ||
    location.hash.startsWith('#/tcp/')
  )
    return;
  if (document.activeElement?.id === 'search-input') return;
  renderList();
}, 5000);

initTheme();
initDialogs();
route();
