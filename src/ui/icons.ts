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

// Theme-switcher icons. Use currentColor so they inherit the button color.
export const iconSun = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <circle cx="12" cy="12" r="4" />
  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
</svg>`;

export const iconMoon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
</svg>`;

// Sign-out icon — door + arrow. Inherits currentColor like the theme icons.
export const iconSignOut = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
  <polyline points="16 17 21 12 16 7" />
  <line x1="21" y1="12" x2="9" y2="12" />
</svg>`;
