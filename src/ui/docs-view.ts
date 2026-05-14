/**
 * In-SPA docs view — fetches the standalone /docs page, extracts its
 * <main> content, and renders it inside the dashboard shell so the
 * navbar + theme persist (no full-page navigation, no theme reset).
 *
 * Sections still deep-link: #/docs/assertions-api scrolls to that
 * anchor after the content lands.
 */

import { $ } from './helpers';

let cachedContent: string | null = null;

async function fetchContent(): Promise<string> {
  if (cachedContent !== null) return cachedContent;
  const res = await fetch('/docs', { credentials: 'include' });
  const html = await res.text();
  // Parse out just the <main>…</main> innerHTML. We avoid DOMParser-ing
  // the whole document into the page (would duplicate the docs page's
  // own <header>) and keep this defensive against future header tweaks.
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const main = doc.querySelector('main');
  cachedContent = main ? main.innerHTML : '<p>Docs unavailable.</p>';
  return cachedContent;
}

export async function renderDocs(section: string | null) {
  const main = $('#main');
  main.innerHTML = '<p class="meta">Loading docs…</p>';
  const content = await fetchContent();
  main.innerHTML = `<div class="docs-embed">${content}</div>`;

  // Scroll to the section anchor (if any) after layout.
  if (section) {
    requestAnimationFrame(() => {
      const target = main.querySelector(`#${CSS.escape(section)}`);
      if (target instanceof HTMLElement)
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
  } else {
    main.scrollTo({ top: 0 });
    window.scrollTo({ top: 0 });
  }
}
