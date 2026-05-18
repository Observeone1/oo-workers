import { test, expect } from '@playwright/test';

test('smoke loads example.com', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('Example Domain');
});