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
  await page.waitForSelector('.regions-page');

  // Create form
  await page.locator('input[name="slug"]').fill(slug);
  await page.locator('input[name="label"]').fill(`E2E ${slug}`);
  await page.locator('#region-create-form button[type="submit"]').click();

  // One-time key panel must appear with a visible key.
  await page.waitForSelector('.one-time-key');
  await expect(page.locator('.one-time-key h3')).toContainText(slug);
  await expect(page.locator('.one-time-key-value code')).toHaveText(/^oo_[A-Za-z0-9_-]{40,}$/);
  await shot('regions_page_one_time_key');

  await page.locator('#dismiss-key-btn').click();
  // Now the new region should be listed.
  await expect(page.locator(`.region-row[data-slug="${slug}"]`)).toBeVisible();

  // Delete it — auto-accept the confirm() dialog.
  page.once('dialog', (d) => d.accept());
  await page
    .locator(`.region-row[data-slug="${slug}"] .region-delete`)
    .click();

  // Wait for the row to disappear after the API call + re-render.
  await expect(page.locator(`.region-row[data-slug="${slug}"]`)).toHaveCount(0, { timeout: 5000 });
});

test('region picker appears in add-monitor dialog when regions exist', async ({ page, shot }) => {
  // Ensure at least one region exists (create one if needed).
  const slug = `e2e-pick-${uniqueSuffix()}`;
  await page.goto('/#/regions');
  await page.waitForSelector('.regions-page');
  await page.locator('input[name="slug"]').fill(slug);
  await page.locator('input[name="label"]').fill(`E2E pick ${slug}`);
  await page.locator('#region-create-form button[type="submit"]').click();
  await page.waitForSelector('.one-time-key');
  await page.locator('#dismiss-key-btn').click();
  await page.waitForSelector(`.region-row[data-slug="${slug}"]`);

  // Go back to the list, open the add-monitor dialog.
  await page.goto('/');
  await waitForList(page);
  await page.click('#add-btn');
  await page.waitForSelector('#add-dialog[open]');
  await expect(page.locator('#regions-row')).toBeVisible();
  await expect(
    page.locator(`#regions-checkboxes input[name="region_id"][value]`).first(),
  ).toBeVisible();
  await shot('add_dialog_with_regions_picker');

  // Cleanup — close dialog, delete region.
  await page.locator('#cancel-btn').click();
  await page.goto('/#/regions');
  await page.waitForSelector(`.region-row[data-slug="${slug}"]`);
  page.once('dialog', (d) => d.accept());
  await page.locator(`.region-row[data-slug="${slug}"] .region-delete`).click();
  await expect(page.locator(`.region-row[data-slug="${slug}"]`)).toHaveCount(0, { timeout: 5000 });
});
