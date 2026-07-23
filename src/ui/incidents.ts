/**
 * Incidents — operator-authored status-page timeline.
 *
 * Two views, swapped on the URL hash:
 *   - `#/incidents` → list view (`incidents/list.ts`)
 *   - `#/incidents/<id>` → editor view (`incidents/editor.ts`)
 *
 * Shared state + severity enums + the sevPill + renderBanner helpers
 * live in `incidents/state.ts` so both views read and mutate one
 * `state` object instead of import-binding gymnastics.
 *
 * This file owns the URL→view router and the dashboard widget helper
 * (`getActiveIncidents`) that the home page uses to surface incidents
 * outside the incidents view.
 */

import { esc, fmtAge } from './helpers';
import { getIncidents, getStatusPages, type IncidentLite } from './api';
import { renderList } from './incidents/list.ts';
import { renderEditor } from './incidents/editor.ts';
import { sevPill } from './incidents/state.ts';

export async function renderIncidents(): Promise<void> {
  const m = /^#\/incidents\/(\d+)$/.exec(location.hash);
  if (m) return renderEditor(Number(m[1]));
  return renderList();
}

/**
 * Fetch active incidents across all status pages.
 * Returns { widget: HTML string (empty if none), count: number }
 */
export async function getActiveIncidents(): Promise<{ widget: string; count: number }> {
  try {
    const pages = await getStatusPages();
    if (pages.length === 0) return { widget: '', count: 0 };
    const allActive = (
      await Promise.all(
        pages.map((p) => getIncidents(p.id, 'active').catch(() => [] as IncidentLite[])),
      )
    ).flat();
    if (allActive.length === 0) return { widget: '', count: 0 };
    const items = allActive
      .slice(0, 3)
      .map((i) => {
        const pageTitle = pages.find((p) => p.id === i.statusPageId)?.title ?? '';
        return `
        <a class="inc-widget-row" href="#/incidents/${i.id}">
          ${sevPill(i.severity)}
          <span class="inc-widget-title">${esc(i.title)}</span>
          <span class="inc-widget-meta">${esc(pageTitle)} · ${fmtAge(i.updatedAt)}</span>
        </a>`;
      })
      .join('');
    const more =
      allActive.length > 3
        ? `<a class="inc-widget-more" href="#/incidents">+${allActive.length - 3} more →</a>`
        : '';
    const widget = `
      <div class="inc-widget">
        <div class="inc-widget-head">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          <span>${allActive.length} active incident${allActive.length === 1 ? '' : 's'}</span>
          <a href="#/incidents" class="inc-widget-link">View all →</a>
        </div>
        ${items}
        ${more}
      </div>`;
    return { widget, count: allActive.length };
  } catch {
    return { widget: '', count: 0 };
  }
}
