import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

const QA_SCRIPT = `import { test, expect } from '@playwright/test';
test('hello', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example/i);
});`;

test('create URL monitor through the dialog', async ({ page, request, shot }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-url-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  // v2: type is a tile (was a <select>); url is the default-active tile.
  await page.getByTestId('add-monitor-type-tile-url').click();
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="url"]').fill('https://example.com');
  await shot('create_url_dialog');
  await page.getByTestId('add-monitor-submit').click();

  await waitForList(page);
  await page.getByTestId('monitors-tab-url').click();
  const row = page.locator('tr[data-open][data-type="url"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  await shot('create_url_list_after');

  // Cleanup
  const list = await (await request.get('/api/monitors')).json();
  const created = list.url.find((m: { name: string; id: number }) => m.name === name);
  if (created) await deleteMonitorViaApi(request, 'url', created.id);
});

test('create API monitor through the dialog', async ({ page, request, shot }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-api-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-api').click();
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="url"]').fill('https://example.com');
  await page.locator('#add-form select[name="api_method"]').selectOption('GET');
  await page
    .locator('#add-form textarea[name="api_assertions"]')
    .fill('[{"type":"status_code","operator":"equals","value":"200"}]');
  await shot('create_api_dialog');
  await page.getByTestId('add-monitor-submit').click();

  await waitForList(page);
  await page.getByTestId('monitors-tab-api').click();
  const row = page.locator('tr[data-open][data-type="api"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  await shot('create_api_list_after');

  const list = await (await request.get('/api/monitors')).json();
  const created = list.api.find((m: { name: string; id: number }) => m.name === name);
  if (created) await deleteMonitorViaApi(request, 'api', created.id);
});

test('create QA (browser) monitor through the dialog', async ({ page, request, shot }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-qa-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-qa').click();
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="url"]').fill('https://example.com');
  await page.locator('#add-form textarea[name="qa_script"]').fill(QA_SCRIPT);
  await shot('create_qa_dialog');
  await page.getByTestId('add-monitor-submit').click();

  await waitForList(page);
  await page.getByTestId('monitors-tab-qa').click();
  const row = page.locator('tr[data-open][data-type="qa"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  await shot('create_qa_list_after');

  const list = await (await request.get('/api/monitors')).json();
  const created = list.qa.find((m: { name: string; id: number }) => m.name === name);
  if (created) await deleteMonitorViaApi(request, 'qa', created.id);
});
