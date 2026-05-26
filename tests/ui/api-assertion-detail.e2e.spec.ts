/**
 * Per-assertion failure breakdown on the API monitor detail page.
 *
 * Before this fix, the Detail column on a FAILED API run just said "One or
 * more assertions failed" — operators couldn't tell which assertion had
 * failed without consulting the DB. The processor already stores
 * `assertion_results` jsonb per row; the UI just wasn't rendering it.
 *
 * This spec creates an API monitor whose assertions are guaranteed to be
 * partial: status code 200 (will pass against example.com), Header
 * Content-Type contains "application/json" (will fail — example.com
 * returns text/html). Once the run lands, the detail page must surface
 * one ✓ row and one ✗ row, not a generic message.
 */

import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

test('API monitor detail shows per-assertion pass/fail breakdown', async ({ page, request }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-assertion-detail-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-api').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-url-input').fill('https://example.com');

  // Default row is status_code equals 200 — should pass.
  // Add a second row that will fail: Header Content-Type contains application/json.
  await page.getByTestId('add-monitor-api-add-assertion').click();
  const rows = page.getByTestId('add-monitor-api-assertion-row');
  const secondRow = rows.nth(1);
  await secondRow.getByTestId('add-monitor-api-assertion-type').selectOption('header');
  await secondRow.getByTestId('add-monitor-api-assertion-operator').selectOption('contains');
  await secondRow.getByTestId('add-monitor-api-assertion-path').fill('Content-Type');
  await secondRow.getByTestId('add-monitor-api-assertion-value').fill('application/json');

  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  // Navigate to the new monitor's detail page.
  await page.getByTestId('monitors-tab-api').click();
  const row = page.locator('tr[data-open][data-type="api"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  // Wait for the first run to land. The processor evaluates assertions and
  // writes assertion_results to the api_executions row. The detail page polls
  // every 5s, so within ~15s the row + its breakdown should appear.
  const breakdown = page.getByTestId('assertion-results').first();
  await expect(breakdown).toBeVisible({ timeout: 30_000 });

  // Both assertions should be in the list. The pass/fail dot uses the same
  // `.dot.up` / `.dot.down` classes the rest of the dashboard uses for
  // status pills.
  await expect(breakdown.locator('li')).toHaveCount(2);
  await expect(breakdown.locator('li .dot.up')).toHaveCount(1);
  await expect(breakdown.locator('li .dot.down')).toHaveCount(1);

  // The status code message wins ✓ (200 equals 200). The Header message
  // wins ✗ (text/html does not contain application/json).
  await expect(breakdown).toContainText(/Status code 200/);
  await expect(breakdown).toContainText(/Content-Type/);

  // Cleanup.
  const list = await (await request.get('/api/monitors')).json();
  const m = list.api?.find((r: { name: string; id: number }) => r.name === name);
  if (m) await deleteMonitorViaApi(request, 'api', m.id);
});
