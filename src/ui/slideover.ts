/**
 * Slide-over panel — right-side drawer replacing create dialogs.
 * CSS lives in dashboard.css (.slideover, .slideover-backdrop).
 */

export interface SlideoverOpts {
  title: string;
  sub?: string;
  body: string;
  primaryLabel?: string;
  onPrimary: (el: HTMLElement) => Promise<void> | void;
}

export function openSlideover(opts: SlideoverOpts): void {
  closeSlideover();

  const backdrop = document.createElement('div');
  backdrop.className = 'slideover-backdrop';
  backdrop.addEventListener('click', closeSlideover);

  const so = document.createElement('aside');
  so.className = 'slideover';
  so.innerHTML = `
    <div class="head">
      <div>
        <h3>${opts.title}</h3>
        ${opts.sub ? `<div class="sub">${opts.sub}</div>` : ''}
      </div>
      <button class="icon-btn" data-close-so aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="body">${opts.body}</div>
    <div class="foot">
      <button class="btn" data-close-so>Cancel</button>
      <button class="btn primary" data-primary-so>${opts.primaryLabel ?? 'Save'}</button>
    </div>
  `;

  document.body.append(backdrop, so);

  so.querySelectorAll('[data-close-so]').forEach((b) =>
    b.addEventListener('click', closeSlideover),
  );

  const primaryBtn = so.querySelector<HTMLButtonElement>('[data-primary-so]')!;
  primaryBtn.addEventListener('click', async () => {
    primaryBtn.disabled = true;
    try {
      await opts.onPrimary(so);
    } finally {
      primaryBtn.disabled = false;
    }
  });

  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeSlideover(); };
  document.addEventListener('keydown', esc, { once: true });
}

export function closeSlideover(): void {
  document.querySelectorAll('.slideover, .slideover-backdrop').forEach((n) => n.remove());
}
