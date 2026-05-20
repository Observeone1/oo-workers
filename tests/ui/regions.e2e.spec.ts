import { test, expect, waitForList, uniqueSuffix } from './fixtures';

// Regions settings page (#/regions). The auth.e2e fixture injects an
// OO_E2E_API_KEY bearer on every request, including the writes used by
// the create/delete buttons.

test('regions page renders header link and lands on #/regions', async ({ page, shot }) => {
  await page.goto('/');
  await waitForList(page);
  const navLink = page.getByTestId('nav-regions');
  await expect(navLink).toBeVisible();
  await navLink.click();
  await expect(page.getByTestId('page-title')).toHaveText('Regions');
  await shot('regions_page_empty_or_seeded');
});

test('create region surfaces one-time key, then delete cleans up', async ({ page, shot }) => {
  const slug = `e2e-${uniqueSuffix()}`;
  await page.goto('/#/regions');
  await expect(page.getByTestId('page-title')).toHaveText('Regions');

  // v2: create moved into a slideover triggered by regions-add-btn.
  await page.getByTestId('regions-add-btn').click();
  const so = page.getByTestId('slideover');
  await expect(so).toBeVisible();
  await so.locator('#so-slug').fill(slug);
  await so.locator('#so-label').fill(`E2E ${slug}`);
  await page.getByTestId('slideover-primary').click();

  // One-time key panel must appear with a visible key.
  const keyPanel = page.getByTestId('region-key-panel');
  await expect(keyPanel).toBeVisible();
  await expect(keyPanel.locator('h4')).toContainText(slug);
  await expect(page.getByTestId('region-key-value')).toHaveText(/^oo_[A-Za-z0-9_-]{40,}$/);
  await shot('regions_page_one_time_key');

  await page.getByTestId('region-key-dismiss-btn').click();
  // Now the new region card should be listed.
  const card = page.getByTestId(`region-card-${slug}`);
  await expect(card).toBeVisible();

  // Delete it — v2 confirms via the in-app confirm dialog (was native confirm()).
  await card.getByTestId('region-delete-btn').click();
  await page.getByTestId('confirm-ok').click();
  await expect(card).toHaveCount(0, { timeout: 5000 });
});

test('region picker appears in add-monitor dialog when regions exist', async ({ page, shot }) => {
  // Ensure at least one region exists (create one if needed).
  const slug = `e2e-pick-${uniqueSuffix()}`;
  await page.goto('/#/regions');
  await expect(page.getByTestId('page-title')).toHaveText('Regions');
  await page.getByTestId('regions-add-btn').click();
  await page.getByTestId('slideover').locator('#so-slug').fill(slug);
  await page.getByTestId('slideover').locator('#so-label').fill(`E2E pick ${slug}`);
  await page.getByTestId('slideover-primary').click();
  await expect(page.getByTestId('region-key-panel')).toBeVisible();
  await page.getByTestId('region-key-dismiss-btn').click();
  await expect(page.getByTestId(`region-card-${slug}`)).toBeVisible();

  // Go back to the list, open the add-monitor dialog.
  await page.goto('/');
  await waitForList(page);
  await page.getByTestId('header-add-monitor-btn').click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  await expect(page.getByTestId('add-monitor-regions-row')).toBeVisible();
  // v2 renamed #regions-checkboxes -> #regions-picker (same as channels-picker rename).
  await expect(
    page.locator('#regions-picker input[name="region_id"][value]').first(),
  ).toBeVisible();
  await shot('add_dialog_with_regions_picker');

  // Cleanup — close dialog (v2: button[data-close-dialog]), delete region.
  await page.locator('#add-dialog button[data-close-dialog]').first().click();
  await page.goto('/#/regions');
  const card = page.getByTestId(`region-card-${slug}`);
  await expect(card).toBeVisible();
  await card.getByTestId('region-delete-btn').click();
  await page.getByTestId('confirm-ok').click();
  await expect(card).toHaveCount(0, { timeout: 5000 });
});
