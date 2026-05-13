import { test, expect, waitForList } from './fixtures';

test.describe('list view', () => {
  test('renders header, tabs, and seed monitors', async ({ page, shot }) => {
    await page.goto('/');
    await waitForList(page);

    await expect(page.locator('header h1')).toContainText('oo-workers');
    await expect(page.locator('#add-btn')).toBeVisible();
    await expect(page.locator('#import-btn')).toBeVisible();

    // The default tab is URL. Counts shown in tabs match the API.
    const api = await (await page.request.get('/api/monitors')).json();
    await expect(page.locator('.tab[data-tab="url"] .count')).toHaveText(String(api.url.length));
    await expect(page.locator('.tab[data-tab="api"] .count')).toHaveText(String(api.api.length));
    await expect(page.locator('.tab[data-tab="qa"] .count')).toHaveText(String(api.qa.length));
    await expect(page.locator('.tab[data-tab="tcp"] .count')).toHaveText(String(api.tcp.length));

    await shot('list_url_tab');
  });

  test('tab switching renders the right slice', async ({ page, shot }) => {
    await page.goto('/');
    await waitForList(page);

    await page.locator('.tab[data-tab="api"]').click();
    await expect(page.locator('.tab.active')).toHaveAttribute('data-tab', 'api');
    await shot('list_api_tab');

    await page.locator('.tab[data-tab="qa"]').click();
    await expect(page.locator('.tab.active')).toHaveAttribute('data-tab', 'qa');
    await shot('list_qa_tab');
  });
});
