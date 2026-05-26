/**
 * In-SPA docs view — fetches the standalone /docs page, extracts its
 * <main> content, and renders it inside the dashboard shell using the
 * new design system: two-column layout with sticky TOC rail + scroll-spy.
 *
 * Sections deep-link: #/docs/assertions-api scrolls to that anchor.
 */

import { $ } from './helpers';

let cachedDoc: Document | null = null;

async function fetchDoc(): Promise<Document> {
  if (cachedDoc) return cachedDoc;
  // /docs is the SPA route that wraps this content in the dashboard
  // shell. Fetch the raw HTML from /docs.html so we don't follow the
  // /docs → /#/docs redirect set up in src/routes/static-ui.ts.
  const res = await fetch('/docs.html', { credentials: 'include' });
  const html = await res.text();
  cachedDoc = new DOMParser().parseFromString(html, 'text/html');
  return cachedDoc;
}

export async function renderDocs(section: string | null) {
  const main = $('#main');
  main.innerHTML = '<p class="meta" style="padding:40px 48px">Loading docs…</p>';

  let doc: Document;
  try {
    doc = await fetchDoc();
  } catch {
    main.innerHTML = '<p class="meta" style="padding:40px 48px">Docs unavailable.</p>';
    return;
  }

  const docMain = doc.querySelector('main');
  if (!docMain) {
    main.innerHTML = '<p class="meta" style="padding:40px 48px">Docs unavailable.</p>';
    return;
  }

  // ── Extract TOC links ──────────────────────────────────────────────────────
  const tocAnchors = Array.from(docMain.querySelectorAll<HTMLAnchorElement>('nav.toc a'));

  const tocHtml = tocAnchors
    .map((a) => {
      const href = a.getAttribute('href') ?? '';
      const id = href.startsWith('#') ? href.slice(1) : href;
      return `<a class="docs-nav-link" href="#/docs/${id}" data-section="${id}">${a.textContent?.trim() ?? id}</a>`;
    })
    .join('');

  // ── Extract content (without the <nav.toc>) ────────────────────────────────
  const clone = docMain.cloneNode(true) as HTMLElement;
  clone.querySelector('nav.toc')?.remove();
  const contentHtml = clone.innerHTML;

  // ── Render ─────────────────────────────────────────────────────────────────
  main.innerHTML = `
    <div class="docs-layout">
      <aside class="docs-rail">
        <div class="docs-rail-head">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
          Documentation
        </div>
        <nav class="docs-nav">${tocHtml}</nav>
      </aside>
      <div class="docs-body" data-testid="docs-body">${contentHtml}</div>
    </div>
  `;

  // ── Scroll-spy ─────────────────────────────────────────────────────────────
  const navLinks = main.querySelectorAll<HTMLAnchorElement>('.docs-nav-link');
  const sectionEls = Array.from(main.querySelectorAll<HTMLElement>('.docs-body section[id]'));

  function setActive(id: string) {
    navLinks.forEach((l) => l.classList.toggle('active', l.dataset.section === id));
  }

  // Intercept TOC clicks → update hash + active state without page reload
  navLinks.forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const id = link.dataset.section ?? '';
      history.replaceState(null, '', `#/docs/${id}`);
      setActive(id);
      const target = main.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Window scroll → update active TOC link
  const onScroll = () => {
    let current = sectionEls[0]?.id ?? '';
    for (const s of sectionEls) {
      if (s.getBoundingClientRect().top <= 80) current = s.id;
    }
    setActive(current);
  };
  window.addEventListener('scroll', onScroll, { passive: true });

  // Cleanup scroll listener when navigating away
  const observer = new MutationObserver(() => {
    if (!document.querySelector('.docs-layout')) {
      window.removeEventListener('scroll', onScroll);
      observer.disconnect();
    }
  });
  observer.observe(main, { childList: true });

  // ── Initial scroll position ────────────────────────────────────────────────
  if (section) {
    setActive(section);
    requestAnimationFrame(() => {
      const target = main.querySelector<HTMLElement>(`#${CSS.escape(section)}`);
      target?.scrollIntoView({ behavior: 'auto', block: 'start' });
    });
  } else {
    setActive(sectionEls[0]?.id ?? '');
    window.scrollTo({ top: 0 });
  }
}
