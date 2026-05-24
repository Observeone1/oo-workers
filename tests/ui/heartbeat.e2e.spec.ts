import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

// Heartbeat add + detail flow (Roadmap 8 UI). Backend gating lives in
// scripts/heartbeat-test.ts — this spec covers the dashboard surface:
// tile click → form swap → submit → detail view shows the public URL.

test('create heartbeat via dialog + detail view exposes the public URL', async ({
  page,
  request,
  shot,
}) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-hb-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  await page.getByTestId('add-monitor-type-tile-heartbeat').click();

  // URL row hides, heartbeat row shows.
  await expect(page.getByTestId('add-monitor-url-row')).toBeHidden();
  await expect(page.getByTestId('add-monitor-heartbeat-row')).toBeVisible();
  // Regions row also hides for heartbeat (it runs nowhere; services ping us).
  // Asserting on the hidden state replaces a previous waitForTimeout(200).
  // The dialog populates region options async, but a hidden regions-row
  // is the deterministic signal that the heartbeat-type swap has settled.
  await expect(page.getByTestId('add-monitor-regions-row')).toBeHidden();

  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('input[name="hb_period_seconds"]').fill('60');
  await page.locator('input[name="hb_grace_seconds"]').fill('30');
  await page
    .locator('input[name="hb_description"]')
    .fill('e2e: nightly backup ping');

  await shot('heartbeat_dialog_filled');

  await page.getByTestId('add-monitor-submit').click();

  // Dialog closes; list re-renders with the new heartbeat tab counter
  // bumped. Switch to the Heartbeat tab to find the row.
  await expect(page.getByTestId('add-monitor-dialog')).not.toBeVisible({ timeout: 5000 });
  await page.getByTestId('monitors-tab-heartbeat').click();
  await waitForList(page);

  // Find the row by name, click into the detail view.
  const row = page.locator(`tr[data-type="heartbeat"]:has-text("${name}")`);
  await expect(row).toBeVisible();
  await row.click();

  // Detail view shows the public URL + copy button.
  const urlBlock = page.getByTestId('heartbeat-ping-url');
  await expect(urlBlock).toBeVisible();
  await expect(urlBlock.locator('code')).toContainText('/heartbeat/');
  await expect(page.getByTestId('heartbeat-copy-url')).toBeVisible();

  await shot('heartbeat_detail_view');

  // Cleanup via API — find the id by scraping the page URL hash.
  const hash = await page.evaluate(() => location.hash);
  const match = hash.match(/heartbeat\/(\d+)/);
  if (match) {
    await deleteMonitorViaApi(request, 'heartbeat', Number(match[1]));
  }
});
