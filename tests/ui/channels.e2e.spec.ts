import { test, expect, waitForList, uniqueSuffix } from './fixtures';

// Alert channels settings page (#/channels). Mirrors the regions e2e
// shape: list, create, test-fire (against a deliberately bad URL so the
// 502 path is exercised), bind in the add-monitor dialog, delete.

test('channels page renders nav link and lands on #/channels', async ({ page, shot }) => {
  await page.goto('/');
  await waitForList(page);
  const navLink = page.getByTestId('nav-channels');
  await expect(navLink).toBeVisible();
  await navLink.click();
  await expect(page.getByTestId('page-title')).toHaveText('Alert channels');
  await shot('channels_page_empty_or_seeded');
});

test('create channel, send test alert (502 path), then delete', async ({ page }) => {
  const name = `e2e-${uniqueSuffix()}`;
  await page.goto('/#/channels');
  await page.waitForSelector('.channels-page');

  // Create — point at a guaranteed-unreachable host so the test fires the
  // 502 path (channel exists, but delivery fails). We only care that the
  // banner renders and the row stays put. Scope selectors to the form so we
  // don't collide with the hidden inputs inside the Add monitor dialog.
  const form = page.locator('#channel-create-form');
  await form.locator('input[name="name"]').fill(name);
  await form.locator('select[name="type"]').selectOption('webhook');
  await form.locator('input[name="url"]').fill('http://127.0.0.1:1/never');
  await form.locator('button[type="submit"]').click();

  await expect(page.locator(`.channel-row[data-channel-name="${name}"]`)).toBeVisible();
  await expect(page.locator('.banner-ok')).toBeVisible();

  // Send-test → banner flips to error (URL unreachable).
  await page.locator(`.channel-row[data-channel-name="${name}"] .channel-test`).click();
  await expect(page.locator('.banner-err')).toBeVisible({ timeout: 15000 });

  // Delete — confirm via native dialog
  await page.locator(`.channel-row[data-channel-name="${name}"] .channel-delete`).click();
  await page.locator('#confirm-dialog .confirm-ok').click();
  await expect(page.locator(`.channel-row[data-channel-name="${name}"]`)).toHaveCount(0, {
    timeout: 5000,
  });
});

test('create an email channel (recipient field) and test-fire without SMTP → error', async ({
  page,
}) => {
  const name = `e2e-email-${uniqueSuffix()}`;
  await page.goto('/#/channels');
  await page.waitForSelector('.channels-page');

  const form = page.locator('#channel-create-form');
  await form.locator('input[name="name"]').fill(name);
  // Selecting email swaps the destination field from URL → Recipient.
  await form.locator('select[name="type"]').selectOption('email');
  await expect(page.locator('#channel-dest-label')).toHaveText('Recipient');
  await expect(page.locator('#channel-dest-input')).toHaveAttribute('type', 'email');
  await form.locator('input[name="url"]').fill('alerts@example.com');
  await form.locator('button[type="submit"]').click();

  // Created (validates the email-address path + config.to server-side).
  await expect(page.locator(`.channel-row[data-channel-name="${name}"]`)).toBeVisible();
  await expect(page.locator('.banner-ok')).toBeVisible();

  // Test-fire: e2e stack has no OO_SMTP_* → sendEmail throws "SMTP not
  // configured", surfaced as the 502 error banner (same as webhook 502).
  await page.locator(`.channel-row[data-channel-name="${name}"] .channel-test`).click();
  await expect(page.locator('.banner-err')).toBeVisible({ timeout: 15000 });

  await page.locator(`.channel-row[data-channel-name="${name}"] .channel-delete`).click();
  await page.locator('#confirm-dialog .confirm-ok').click();
  await expect(page.locator(`.channel-row[data-channel-name="${name}"]`)).toHaveCount(0, {
    timeout: 5000,
  });
});

test('channel picker appears in add-monitor dialog when channels exist', async ({ page, shot }) => {
  const name = `e2e-pick-${uniqueSuffix()}`;
  await page.goto('/#/channels');
  await page.waitForSelector('.channels-page');
  const form = page.locator('#channel-create-form');
  await form.locator('input[name="name"]').fill(name);
  await form.locator('select[name="type"]').selectOption('webhook');
  await form.locator('input[name="url"]').fill('https://example.com/webhook');
  await form.locator('button[type="submit"]').click();
  await page.waitForSelector(`.channel-row[data-channel-name="${name}"]`);

  // Go back to list and open the add-monitor dialog.
  await page.goto('/');
  await waitForList(page);
  await page.click('#add-btn');
  await page.waitForSelector('#add-dialog[open]');
  await expect(page.locator('#channels-row')).toBeVisible();
  await expect(
    page.locator('#channels-checkboxes input[name="channel_id"][value]').first(),
  ).toBeVisible();
  await shot('add_dialog_with_channels_picker');

  // Cleanup.
  await page.locator('#cancel-btn').click();
  await page.goto('/#/channels');
  await page.waitForSelector(`.channel-row[data-channel-name="${name}"]`);
  await page.locator(`.channel-row[data-channel-name="${name}"] .channel-delete`).click();
  await page.locator('#confirm-dialog .confirm-ok').click();
  await expect(page.locator(`.channel-row[data-channel-name="${name}"]`)).toHaveCount(0, {
    timeout: 5000,
  });
});
