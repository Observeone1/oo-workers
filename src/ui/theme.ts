/**
 * Theme switcher. Two states: 'light' | 'dark'. Persisted in localStorage.
 * First visit (no stored pref) follows prefers-color-scheme via the
 * default `color-scheme: light dark` on :root.
 *
 * Once the user clicks the toggle, the choice becomes explicit and we
 * set `color-scheme: light` or `color-scheme: dark` on <html>, which the
 * `light-dark()` CSS function in tokens.css picks up automatically.
 */

import { iconSun, iconMoon } from './icons';

type Theme = 'light' | 'dark';
const STORAGE_KEY = 'oo-workers:theme';

function resolved(): Theme {
  const colorScheme = getComputedStyle(document.documentElement).colorScheme;
  // 'light dark' (default) → follow system; otherwise honor the explicit value.
  if (colorScheme === 'light' || colorScheme === 'dark') return colorScheme;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function apply(theme: Theme) {
  document.documentElement.style.colorScheme = theme;
  document.documentElement.dataset.theme = theme;
  // Mirror to a cookie so the public status page can match the operator's
  // theme. The status page has CSP script-src 'none' and can't read
  // localStorage, so the server reads `oo-theme` and emits a <meta> tag.
  document.cookie = `oo-theme=${theme}; path=/; max-age=31536000; samesite=lax`;
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.innerHTML = theme === 'dark' ? iconSun : iconMoon;
    btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  }
}

export function initTheme() {
  // Restore stored choice on load. No stored pref → leave color-scheme alone
  // (defaults to `light dark` from tokens.css, which follows the system).
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored === 'light' || stored === 'dark') {
    apply(stored);
  } else {
    // Still set the button icon based on the resolved theme.
    apply(resolved());
  }

  const btn = document.getElementById('theme-toggle');
  btn?.addEventListener('click', () => {
    const next: Theme = resolved() === 'dark' ? 'light' : 'dark';
    localStorage.setItem(STORAGE_KEY, next);
    apply(next);
  });

  // Update icon if the system theme changes AND no explicit pref is set.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (localStorage.getItem(STORAGE_KEY) === null) apply(resolved());
  });
}
