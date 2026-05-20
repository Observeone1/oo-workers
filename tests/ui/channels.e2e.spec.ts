import { test, expect, waitForList, uniqueSuffix } from './fixtures';

// Alert channels settings page (#/channels). v2 redesign moved create
// from an inline form into a slideover. Channel rows are now
// .channel-card with data-testid='channel-card-{name}'.

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
  await expect(page.getByTestId('page-title')).toHaveText('Alert channels');

  // Create via slideover — point at a guaranteed-unreachable host so the
  // test fires the 502 path (channel exists, but delivery fails).
  await page.getByTestId('channels-add-btn').click();
  const so = page.locator('.slideover');
  await expect(so).toBeVisible();
  await so.locator('#so-ch-name').fill(name);
  // Webhook is the default-checked type radio.
  await so.locator('input[name="so-ch-type"][value="webhook"]').check();
  await so.locator('#so-ch-url').fill('http://127.0.0.1:1/never');
  await page.getByTestId('slideover-primary').click();

  const card = page.getByTestId(`channel-card-${name}`);
  await expect(card).toBeVisible();
  await expect(page.locator('.banner-ok')).toBeVisible();

  // Send-test → banner flips to error (URL unreachable).
  await card.locator('.channel-test').click();
  await expect(page.locator('.banner-err')).toBeVisible({ timeout: 15000 });

  // Delete — confirm via native dialog
  await card.locator('.channel-delete').click();
  await page.locator('#confirm-dialog .confirm-ok').click();
  await expect(card).toHaveCount(0, { timeout: 5000 });
});

test('create an email channel (recipient field) and test-fire without SMTP → error', async ({
  page,
}) => {
  const name = `e2e-email-${uniqueSuffix()}`;
  await page.goto('/#/channels');
  await expect(page.getByTestId('page-title')).toHaveText('Alert channels');

  await page.getByTestId('channels-add-btn').click();
  const so = page.locator('.slideover');
  await expect(so).toBeVisible();
  await so.locator('#so-ch-name').fill(name);
  // Selecting email swaps the destination field from URL → Recipient.
  await so.locator('input[name="so-ch-type"][value="email"]').check();
  await expect(so.locator('#so-ch-email-field')).toBeVisible();
  await so.locator('#so-ch-email').fill('alerts@example.com');
  await page.getByTestId('slideover-primary').click();

  // Created (validates the email-address path + config.to server-side).
  const card = page.getByTestId(`channel-card-${name}`);
  await expect(card).toBeVisible();
  await expect(page.locator('.banner-ok')).toBeVisible();

  // Test-fire: e2e stack has no OO_SMTP_* → sendEmail throws "SMTP not
  // configured", surfaced as the 502 error banner (same as webhook 502).
  await card.locator('.channel-test').click();
  await expect(page.locator('.banner-err')).toBeVisible({ timeout: 15000 });

  await card.locator('.channel-delete').click();
  await page.locator('#confirm-dialog .confirm-ok').click();
  await expect(card).toHaveCount(0, { timeout: 5000 });
});

test('channel picker appears in add-monitor dialog when channels exist', async ({ page, shot }) => {
  const name = `e2e-pick-${uniqueSuffix()}`;
  await page.goto('/#/channels');
  await page.getByTestId('channels-add-btn').click();
  await page.locator('.slideover #so-ch-name').fill(name);
  await page.locator('.slideover input[name="so-ch-type"][value="webhook"]').check();
  await page.locator('.slideover #so-ch-url').fill('https://example.com/webhook');
  await page.getByTestId('slideover-primary').click();
  await expect(page.getByTestId(`channel-card-${name}`)).toBeVisible();

  // Go back to list and open the add-monitor dialog.
  await page.goto('/');
  await waitForList(page);
  await page.getByTestId('header-add-monitor-btn').click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  await expect(page.locator('#channels-row')).toBeVisible();
  await expect(
    // v2 renamed the picker container #channels-checkboxes -> #channels-picker.
    page.locator('#channels-picker input[name="channel_id"][value]').first(),
  ).toBeVisible();
  await shot('add_dialog_with_channels_picker');

  // Cleanup. Close the dialog (the v2 dialog uses [data-close-dialog]).
  await page.locator('#add-dialog [data-close-dialog]').first().click();
  await page.goto('/#/channels');
  const card = page.getByTestId(`channel-card-${name}`);
  await expect(card).toBeVisible();
  await card.locator('.channel-delete').click();
  await page.locator('#confirm-dialog .confirm-ok').click();
  await expect(card).toHaveCount(0, { timeout: 5000 });
});
