export const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

export const $$ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  Array.from(document.querySelectorAll(sel)) as T[];

export const esc = (s: string) =>
  (s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

export const fmtAge = (iso?: string | null) => {
  if (!iso) return 'never';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
};

// Relative age that the clock-tick (src/ui/app.ts) advances in place.
// Stamps the ISO on a span so the tick can rewrite just this text node —
// no view re-render, no flicker. tickRelativeAges() re-reads data-iso.
export const fmtAgeLive = (iso?: string | null) =>
  `<span class="rel-age" data-iso="${iso ?? ''}">${fmtAge(iso)}</span>`;

// Walk every fmtAgeLive() span and refresh its text from the stamped ISO.
// Cheap enough to run every second — it touches only text nodes.
export const tickRelativeAges = () => {
  for (const el of $$('.rel-age')) {
    el.textContent = fmtAge(el.dataset.iso || null);
  }
};

// Map an execution status string to the CSS class used by .dot styles.
// Unknown values fall back to the gray "unknown" dot.
const STATUS_CLASS: Record<string, string> = {
  // API status values → new CSS dot classes
  SUCCESS: 'up',
  FAILED: 'down',
  PENDING: 'pending',
  // Heartbeat-only enum: UP is the same green as SUCCESS, OVERDUE the
  // same red as FAILED. Treated identically by the fleet stats.
  UP: 'up',
  OVERDUE: 'down',
  passed: 'up',
  failed: 'down',
  error: 'down',
  running: 'running',
  up: 'up',
  down: 'down',
  warn: 'warn',
};
export const statusClass = (s: string | undefined | null) => STATUS_CLASS[s ?? ''] ?? '';

// Shared client-side pagination. Pure slicing + a render/wire pair so any
// list can opt in without re-inventing the prev/next/page-of-N footer.
export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number,
): { pageRows: T[]; totalPages: number; page: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * pageSize;
  return { pageRows: items.slice(start, start + pageSize), totalPages, page: safePage };
}

export function paginationFooter(page: number, totalPages: number): string {
  if (totalPages <= 1) return '';
  return `<div class="pagination">
    <button class="btn sm" data-page-prev ${page === 1 ? 'disabled' : ''}>← Prev</button>
    <span class="cell-meta">Page ${page} of ${totalPages}</span>
    <button class="btn sm" data-page-next ${page === totalPages ? 'disabled' : ''}>Next →</button>
  </div>`;
}

export function wirePagination(
  root: ParentNode,
  currentPage: number,
  totalPages: number,
  onChange: (newPage: number) => void,
): void {
  root.querySelector('[data-page-prev]')?.addEventListener('click', () => {
    if (currentPage > 1) onChange(currentPage - 1);
  });
  root.querySelector('[data-page-next]')?.addEventListener('click', () => {
    if (currentPage < totalPages) onChange(currentPage + 1);
  });
}
