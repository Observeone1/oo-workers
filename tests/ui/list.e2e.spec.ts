import { test, expect, waitForList } from './fixtures';

test.describe('list view', () => {
  test('renders header, tabs, and seed monitors', async ({ page, shot }) => {
    await page.goto('/');
    await waitForList(page);

    await expect(page.getByTestId('brand')).toContainText('oo-workers');
    await expect(page.getByTestId('header-add-monitor-btn')).toBeVisible();
    await expect(page.getByTestId('header-import-btn')).toBeVisible();

    // The default tab is URL. Counts shown in tabs match the API.
    const api = await (await page.request.get('/api/monitors')).json();
    for (const t of ['url', 'api', 'qa', 'tcp', 'udp'] as const) {
      await expect(page.getByTestId(`monitors-tab-${t}-count`)).toHaveText(
        String(api[t].length),
      );
    }

    await shot('list_url_tab');
  });

  test('tab switching renders the right slice', async ({ page, shot }) => {
    await page.goto('/');
    await waitForList(page);

    await page.getByTestId('monitors-tab-api').click();
    await expect(page.getByTestId('monitors-tab-api')).toHaveClass(/active/);
    await shot('list_api_tab');

    await page.getByTestId('monitors-tab-qa').click();
    await expect(page.getByTestId('monitors-tab-qa')).toHaveClass(/active/);
    await shot('list_qa_tab');
  });
});
