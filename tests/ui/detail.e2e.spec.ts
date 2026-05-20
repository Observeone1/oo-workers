import { test, expect, waitForList, seedUrlMonitor, deleteMonitorViaApi } from './fixtures';

// global-setup purges the DB before every run, so the list starts
// empty. Seed one URL monitor so there's a row to click into.
let seededId = 0;
test.beforeAll(async ({ request }) => {
  seededId = (await seedUrlMonitor(request)).id;
});
test.afterAll(async ({ request }) => {
  if (seededId > 0) await deleteMonitorViaApi(request, 'url', seededId);
});

test('opens detail view from list and shows meta cards + sparkline', async ({ page, shot }) => {
  await page.goto('/');
  await waitForList(page);

  // Click the first URL row.
  const firstRow = page.locator('tr[data-open][data-type="url"]').first();
  await firstRow.waitFor();
  await firstRow.click();

  await expect(page.locator('.back-link')).toBeVisible();
  // v2 renamed the wrapper .detail-meta -> .detail-grid; we anchored a
  // stable testid on it. Cards themselves keep .meta-card (no churn).
  await expect(page.getByTestId('detail-meta-cards').locator('.meta-card')).toHaveCount(4);
  await expect(page.locator('svg.sparkline')).toBeVisible();
  await expect(page.locator('#detail-run')).toBeVisible();

  // Status card uses an inline SVG icon (not the emoji that headless chromium
  // couldn't render). Active or paused, the meta-card must contain an svg.
  const statusCard = page.getByTestId('detail-meta-cards').locator('.meta-card').last();
  await expect(statusCard.locator('svg[aria-label="active"], svg[aria-label="paused"]')).toHaveCount(1);

  await shot('detail_view');

  // Back link returns to list.
  await page.locator('.back-link').click();
  await waitForList(page);
});
