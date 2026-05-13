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

  await shot('detail_view');

  // Back link returns to list.
  await page.locator('.back-link').click();
  await waitForList(page);
});
