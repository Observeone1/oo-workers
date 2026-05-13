import { test, expect, waitForList } from './fixtures';

test('opens detail view from list and shows meta cards + sparkline', async ({ page, shot }) => {
  await page.goto('/');
  await waitForList(page);

  // Click the first URL row.
  const firstRow = page.locator('tr[data-open][data-type="url"]').first();
  await firstRow.waitFor();
  await firstRow.click();

  await expect(page.locator('.back-link')).toBeVisible();
  await expect(page.locator('.detail-meta .meta-card')).toHaveCount(4);
  await expect(page.locator('svg.sparkline')).toBeVisible();
  await expect(page.locator('#detail-run')).toBeVisible();

  // Status card uses an inline SVG icon (not the emoji that headless chromium
  // couldn't render). Active or paused, the meta-card must contain an svg.
  const statusCard = page.locator('.detail-meta .meta-card').last();
  await expect(statusCard.locator('svg[aria-label="active"], svg[aria-label="paused"]')).toHaveCount(1);

  await shot('detail_view');

  // Back link returns to list.
  await page.locator('.back-link').click();
  await waitForList(page);
});
