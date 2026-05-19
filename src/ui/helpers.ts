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

// Map an execution status string to the CSS class used by .dot styles.
// Unknown values fall back to the gray "unknown" dot.
const STATUS_CLASS: Record<string, string> = {
  // API status values → new CSS dot classes
  SUCCESS: 'up',
  FAILED: 'down',
  PENDING: 'pending',
  passed: 'up',
  failed: 'down',
  error: 'down',
  running: 'running',
  up: 'up',
  down: 'down',
  warn: 'warn',
};
export const statusClass = (s: string | undefined | null) => STATUS_CLASS[s ?? ''] ?? '';
