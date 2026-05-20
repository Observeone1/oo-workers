import { test, expect } from './fixtures';

test('/docs renders and exposes the anchors linked from the add-monitor dialog', async ({
  page,
}) => {
  await page.goto('/docs');
  await expect(page).toHaveTitle(/docs/i);

  // The Add-monitor dialog's "?" hints link to these anchors — assert
  // them before the screenshot so the capability check completes even
  // if Chrome's fullPage screenshot trips on this long page.
  for (const anchor of ['assertions-url', 'assertions-api', 'playwright', 'import']) {
    const el = page.locator(`#${anchor}`);
    await expect(el, `missing #${anchor} on /docs`).toHaveCount(1);
  }

  // Viewport-only screenshot (not via the shot fixture). The docs page
  // is tall enough that `fullPage: true` raced font/layout settling on
  // Chrome CDP and returned 'Unable to capture screenshot'. The capture
  // is documentation-only; the anchor checks above are the capability.
  await page.screenshot({
    path: 'tests/ui/screenshots/docs_top.png',
    fullPage: false,
  });
});
