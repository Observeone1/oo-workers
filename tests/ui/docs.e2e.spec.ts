import { test, expect } from './fixtures';

test('/docs renders and exposes the anchors linked from the add-monitor dialog', async ({
  page,
  shot,
}) => {
  await page.goto('/docs');
  await expect(page).toHaveTitle(/docs/i);
  await shot('docs_top');

  // The Add-monitor dialog's "?" hints link to these anchors.
  for (const anchor of ['assertions-url', 'assertions-api', 'playwright', 'import']) {
    const el = page.locator(`#${anchor}`);
    await expect(el, `missing #${anchor} on /docs`).toHaveCount(1);
  }
});
