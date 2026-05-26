/**
 * Dialog UX cleanup batch — covers the friction items shipped in this PR:
 *
 *   - Context-aware default type (opens with the active tab's tile pre-selected)
 *   - Clickable empty-state CTA per tab
 *   - Edit-mode dialog title and submit button labels
 *   - Form-state cleared between edit and next create (no field leak)
 *   - Heartbeat detail page Edit button (was missing — only 7 of 8 types had it)
 *   - Heartbeat list row hides the Run-now action (push-based, nothing to run)
 *
 * Each scenario is its own test so a partial failure points squarely at the
 * regression, not a cascade.
 */

import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

test('+ Add monitor opens with the active tab pre-selected (TCP)', async ({ page }) => {
  await page.goto('/');
  await waitForList(page);

  await page.getByTestId('monitors-tab-tcp').click();
  await page.getByTestId('header-add-monitor-btn').click();

  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  // Pre-selected tile carries the .active class — same signal the list-row
  // pencil uses in edit mode.
  await expect(page.getByTestId('add-monitor-type-tile-tcp')).toHaveClass(/active/);
  await expect(page.getByTestId('add-monitor-type-tile-url')).not.toHaveClass(/active/);
});

test('empty-state CTA opens the dialog with the matching type', async ({ page }) => {
  await page.goto('/');
  await waitForList(page);

  // UDP starts empty in a fresh stack — the CTA should be visible there.
  await page.getByTestId('monitors-tab-udp').click();
  const cta = page.getByTestId('empty-state-add-link');
  await expect(cta).toBeVisible();
  await expect(cta).toHaveText(/Add a UDP monitor/);

  await cta.click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  await expect(page.getByTestId('add-monitor-type-tile-udp')).toHaveClass(/active/);
});

test('edit-mode dialog header reads "Edit monitor" + submit reads "Save"', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-edit-labels-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-url').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-url-input').fill('https://example.com');
  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  // Edit via pencil and assert the dialog labels switch.
  await page.getByTestId('monitors-tab-url').click();
  const row = page.locator('tr[data-open][data-type="url"]', { hasText: name });
  await row.getByTestId('monitor-row-edit').click();

  await expect(page.locator('#add-dialog .dialog-head h2')).toHaveText('Edit monitor');
  await expect(page.getByTestId('add-monitor-submit')).toHaveText('Save');

  // Cancel out, then click + Add monitor → labels reset to create-mode.
  await page.locator('#add-dialog [data-close-dialog]').first().click();
  await page.getByTestId('header-add-monitor-btn').click();
  await expect(page.locator('#add-dialog .dialog-head h2')).toHaveText('New monitor');
  await expect(page.getByTestId('add-monitor-submit')).toHaveText('Create monitor');

  // Cleanup.
  const list = await (await request.get('/api/monitors')).json();
  const m = list.url?.find((r: { name: string; id: number }) => r.name === name);
  if (m) await deleteMonitorViaApi(request, 'url', m.id);
});

test('no field leak from edit → create (form is cleared between flows)', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-leak-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-url').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-url-input').fill('https://example.com');
  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  // Open the edit dialog so fields are populated...
  const row = page.locator('tr[data-open][data-type="url"]', { hasText: name });
  await row.getByTestId('monitor-row-edit').click();
  await expect(page.getByTestId('add-monitor-name-input')).toHaveValue(name);

  // ...then cancel without saving, then open the create dialog. The previous
  // edit's name must NOT be carried over.
  await page.locator('#add-dialog [data-close-dialog]').first().click();
  await page.getByTestId('header-add-monitor-btn').click();
  await expect(page.getByTestId('add-monitor-name-input')).toHaveValue('');
  await expect(page.getByTestId('add-monitor-url-input')).toHaveValue('');

  // Cleanup.
  const list = await (await request.get('/api/monitors')).json();
  const m = list.url?.find((r: { name: string; id: number }) => r.name === name);
  if (m) await deleteMonitorViaApi(request, 'url', m.id);
});

test('heartbeat detail page surfaces an Edit button', async ({ page, request }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-hb-edit-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-heartbeat').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  await page.getByTestId('monitors-tab-heartbeat').click();
  const row = page.locator('tr[data-open][data-type="heartbeat"]', { hasText: name });
  await row.click();
  await expect(page.getByTestId('detail-edit-btn')).toBeVisible();

  // And clicking it should open the dialog in edit mode with the heartbeat type locked.
  await page.getByTestId('detail-edit-btn').click();
  await expect(page.locator('#add-dialog .dialog-head h2')).toHaveText('Edit monitor');
  await expect(page.getByTestId('add-monitor-type-tile-heartbeat')).toHaveClass(/active/);
  // Other type tiles are disabled in edit mode.
  await expect(page.getByTestId('add-monitor-type-tile-url')).toBeDisabled();

  // Cleanup.
  const list = await (await request.get('/api/monitors')).json();
  const m = list.heartbeat?.find((r: { name: string; id: number }) => r.name === name);
  if (m) await deleteMonitorViaApi(request, 'heartbeat', m.id);
});

test('heartbeat list rows do NOT show the Run-now button', async ({ page, request }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-hb-no-run-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-heartbeat').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  await page.getByTestId('monitors-tab-heartbeat').click();
  const row = page.locator('tr[data-open][data-type="heartbeat"]', { hasText: name });
  // Run-now is a button with title="Run now"; pencil + delete remain.
  await expect(row.locator('button[title="Run now"]')).toHaveCount(0);
  // Edit (pencil) is still present.
  await expect(row.getByTestId('monitor-row-edit')).toBeVisible();

  // Cleanup.
  const list = await (await request.get('/api/monitors')).json();
  const m = list.heartbeat?.find((r: { name: string; id: number }) => r.name === name);
  if (m) await deleteMonitorViaApi(request, 'heartbeat', m.id);
});
