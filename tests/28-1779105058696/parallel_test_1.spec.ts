import { test, expect } from '@playwright/test';
test('parallel 1', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page.locator('h1')).toHaveText('Example Domain');
});