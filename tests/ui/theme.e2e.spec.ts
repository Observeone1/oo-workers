import { test, expect, waitForList } from './fixtures';

test('theme toggle flips data-theme + persists to localStorage', async ({ page, shot }) => {
  // Force the system color-scheme so initial render is deterministic.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.addInitScript(() => {
    try {
      localStorage.removeItem('oo-workers:theme');
    } catch {
      /* ignore */
    }
  });

  await page.goto('/');
  await waitForList(page);

  const toggle = page.locator('#theme-toggle');
  await expect(toggle).toBeVisible();
  // Initial: dark (system pref, no stored override).
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Click → light.
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await shot('theme_light');

  // Click → dark, and this time it's an explicit choice in localStorage.
  await toggle.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot('theme_dark');

  const stored = await page.evaluate(() => localStorage.getItem('oo-workers:theme'));
  expect(stored).toBe('dark');

  // Reload — explicit dark survives.
  await page.reload();
  await waitForList(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('tooltips render via data-tooltip on the ? hint icons', async ({ page, shot }) => {
  await page.goto('/');
  await waitForList(page);
  await page.locator('#add-btn').click();
  // Default tab is URL — its hint icon has the assertions tooltip.
  const hint = page.locator('a.hint[data-tooltip]').first();
  await expect(hint).toBeVisible();
  // The data-tooltip attribute carries the message — that's what CSS renders.
  await expect(hint).toHaveAttribute('data-tooltip', 'URL assertions reference');
  await hint.hover();
  await shot('tooltip_hover');
});
