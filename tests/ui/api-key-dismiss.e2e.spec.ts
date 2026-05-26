/**
 * Settings → API keys: "I've copied it" button dismisses the reveal panel.
 *
 * Before this fix, the reveal panel rendered into #s-key-reveal-host but
 * the host was never cleared on subsequent re-renders when oneTimeKey
 * went back to null. The button read like a confirmation but visually
 * did nothing.
 *
 * Scenario: create a key (panel appears with cleartext) → click "I've
 * copied it" → panel goes away → cleartext is no longer in the DOM.
 */

import { test, expect, waitForList } from './fixtures';

test('I\'ve copied it dismisses the one-time API-key reveal panel', async ({ page }) => {
  await page.goto('/');
  await waitForList(page);

  // Settings → API keys
  await page.getByTestId('header-settings-btn').click();
  await page.locator('a[href="#/settings/api-keys"]').click();
  await expect(page.locator('#s-keys-tbody')).toBeVisible();

  // Open the slideover, mint a key.
  await page.locator('#s-add-key').click();
  const slide = page.locator('.slideover');
  await expect(slide).toBeVisible();
  await slide.locator('input[name="name"]').fill(`e2e-dismiss-${Date.now()}`);
  await slide.getByRole('button', { name: /^Create/ }).click();

  // The reveal panel should now contain the cleartext key.
  const cleartext = page.getByTestId('key-cleartext');
  await expect(cleartext).toBeVisible();
  const dismiss = page.getByTestId('keys-dismiss-btn');
  await expect(dismiss).toBeVisible();

  // Click dismiss — the panel should disappear.
  await dismiss.click();
  await expect(cleartext).toBeHidden();
  await expect(dismiss).toBeHidden();
});
