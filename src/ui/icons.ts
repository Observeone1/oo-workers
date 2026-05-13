// Inline SVG icons. Brand colors are hardcoded — these only render in
// contexts where the dark background is fixed. Sized at 20px to align
// naturally with the meta-card value font-size.

export const iconActive = `<svg width="20" height="20" viewBox="0 0 20 20" aria-label="active" style="vertical-align:-4px">
  <circle cx="10" cy="10" r="9" fill="#10b981" />
  <path d="M5.5 10.5 L8.5 13.5 L14.5 7.5" stroke="white" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" />
</svg>`;

export const iconPaused = `<svg width="20" height="20" viewBox="0 0 20 20" aria-label="paused" style="vertical-align:-4px">
  <circle cx="10" cy="10" r="9" fill="#64748b" />
  <rect x="7" y="6" width="2" height="8" fill="white" />
  <rect x="11" y="6" width="2" height="8" fill="white" />
</svg>`;
