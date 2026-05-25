import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

test('edit URL monitor via pencil icon on list row', async ({ page, request, shot }) => {
  await page.goto('/');
  await waitForList(page);

  // Create a monitor to edit.
  const name = `e2e-edit-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-url').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-url-input').fill('https://example.com');
  await page.getByTestId('add-monitor-submit').click();

  await waitForList(page);
  await page.getByTestId('monitors-tab-url').click();
  const row = page.locator('tr[data-open][data-type="url"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });

  // Click the pencil icon — should open the dialog in edit mode.
  await row.getByTestId('monitor-row-edit').click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();

  // Name field must be pre-populated with the existing monitor name.
  await expect(page.getByTestId('add-monitor-name-input')).toHaveValue(name);
  await shot('edit_url_dialog_prepopulated');

  // Update the name and submit.
  const updatedName = `${name}-updated`;
  await page.getByTestId('add-monitor-name-input').fill(updatedName);
  await page.getByTestId('add-monitor-submit').click();

  // The updated name must appear in the list.
  await waitForList(page);
  await page.getByTestId('monitors-tab-url').click();
  await expect(
    page.locator('tr[data-open][data-type="url"]', { hasText: updatedName }),
  ).toBeVisible({ timeout: 5000 });
  // Old name must be gone.
  await expect(
    page.locator('tr[data-open][data-type="url"]', { hasText: name }),
  ).toHaveCount(0);
  await shot('edit_url_list_after');

  // Cleanup.
  const list = await (await request.get('/api/monitors')).json();
  const monitor = list.url?.find((m: { name: string; id: number }) => m.name === updatedName);
  if (monitor) await deleteMonitorViaApi(request, 'url', monitor.id);
});

test('edit URL monitor via Edit button on detail page', async ({ page, request, shot }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-detail-edit-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-url').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-url-input').fill('https://example.com');
  await page.getByTestId('add-monitor-submit').click();

  await waitForList(page);
  await page.getByTestId('monitors-tab-url').click();
  const row = page.locator('tr[data-open][data-type="url"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });

  // Navigate to the detail page.
  await row.click();
  await expect(page.getByTestId('detail-meta-cards')).toBeVisible({ timeout: 5000 });

  // Click the Edit button in the detail header.
  await page.getByTestId('detail-edit-btn').click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  await expect(page.getByTestId('add-monitor-name-input')).toHaveValue(name);
  await shot('edit_url_detail_dialog');

  // Change the name and submit.
  const updatedName = `${name}-updated`;
  await page.getByTestId('add-monitor-name-input').fill(updatedName);
  await page.getByTestId('add-monitor-submit').click();

  // After submit, should land back on the URL list with the updated row.
  await waitForList(page);
  await page.getByTestId('monitors-tab-url').click();
  await expect(
    page.locator('tr[data-open][data-type="url"]', { hasText: updatedName }),
  ).toBeVisible({ timeout: 5000 });
  await shot('edit_url_detail_list_after');

  // Cleanup.
  const list = await (await request.get('/api/monitors')).json();
  const monitor = list.url?.find((m: { name: string; id: number }) => m.name === updatedName);
  if (monitor) await deleteMonitorViaApi(request, 'url', monitor.id);
});
