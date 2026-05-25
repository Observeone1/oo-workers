/**
 * Structured API-assertion builder in the Add Monitor dialog.
 *
 * Locks down the fix for the v1.23.0 "POST /api/monitors/api with
 * type:undefined → 500" bug. The dialog used to ship a freeform JSON
 * textarea; users wrote `{operator,value}` without `type` and the
 * NOT NULL constraint on api_assertions.type returned 500. Now:
 *
 *  - dialog opens with one prefilled row (status_code/equals/200)
 *  - + Add assertion appends a row
 *  - choosing json_path or header reveals the path input
 *  - × removes a row
 *  - the resulting POST body has every assertion with valid type+operator
 */

import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

test('default row submits a valid status_code assertion', async ({ page, request }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-api-assert-default-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-api').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-url-input').fill('https://example.com');

  // One default row is auto-populated when the dialog opens.
  const rows = page.getByTestId('add-monitor-api-assertion-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId('add-monitor-api-assertion-type')).toHaveValue(
    'status_code',
  );
  await expect(rows.first().getByTestId('add-monitor-api-assertion-value')).toHaveValue('200');

  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);
  // Wait for the new row to actually appear before probing the API, so the
  // GET sees the same committed state the user does.
  await page.getByTestId('monitors-tab-api').click();
  await expect(
    page.locator('tr[data-open][data-type="api"]', { hasText: name }),
  ).toBeVisible({ timeout: 5000 });

  // The monitor exists and the assertion came through with a valid `type`.
  const list = await (await request.get('/api/monitors')).json();
  const created = list.api.find((m: { name: string; id: number }) => m.name === name);
  expect(created).toBeDefined();
  const detail = await (await request.get(`/api/monitors/api/${created.id}`)).json();
  expect(detail.assertions).toHaveLength(1);
  expect(detail.assertions[0].type).toBe('status_code');
  expect(detail.assertions[0].operator).toBe('equals');
  expect(detail.assertions[0].value).toBe('200');

  await deleteMonitorViaApi(request, 'api', created.id);
});

test('+ Add assertion appends a row; type=header reveals path input', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-api-assert-multi-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-api').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-url-input').fill('https://example.com');

  await page.getByTestId('add-monitor-api-add-assertion').click();
  const rows = page.getByTestId('add-monitor-api-assertion-row');
  await expect(rows).toHaveCount(2);

  // Switch second row to 'header' — the path input must become visible.
  const secondRow = rows.nth(1);
  const pathInput = secondRow.getByTestId('add-monitor-api-assertion-path');
  await expect(pathInput).toBeHidden(); // default type is status_code → no path
  await secondRow.getByTestId('add-monitor-api-assertion-type').selectOption('header');
  await expect(pathInput).toBeVisible();
  await pathInput.fill('Content-Type');
  await secondRow.getByTestId('add-monitor-api-assertion-operator').selectOption('contains');
  await secondRow.getByTestId('add-monitor-api-assertion-value').fill('json');

  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);
  // Wait for the new row to actually appear before probing the API, so the
  // GET sees the same committed state the user does.
  await page.getByTestId('monitors-tab-api').click();
  await expect(
    page.locator('tr[data-open][data-type="api"]', { hasText: name }),
  ).toBeVisible({ timeout: 5000 });

  const list = await (await request.get('/api/monitors')).json();
  const created = list.api.find((m: { name: string; id: number }) => m.name === name);
  expect(created).toBeDefined();
  const detail = await (await request.get(`/api/monitors/api/${created.id}`)).json();
  expect(detail.assertions).toHaveLength(2);
  const header = detail.assertions.find(
    (a: { type: string }) => a.type === 'header',
  ) as { path: string; operator: string; value: string };
  expect(header).toBeDefined();
  expect(header.path).toBe('Content-Type');
  expect(header.operator).toBe('contains');
  expect(header.value).toBe('json');

  await deleteMonitorViaApi(request, 'api', created.id);
});

test('× removes a row; empty assertions array submits successfully', async ({ page, request }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-api-assert-empty-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-api').click();
  await page.getByTestId('add-monitor-name-input').fill(name);
  await page.getByTestId('add-monitor-url-input').fill('https://example.com');

  await page.getByTestId('add-monitor-api-assertion-remove').click();
  await expect(page.getByTestId('add-monitor-api-assertion-row')).toHaveCount(0);

  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);
  // Wait for the new row to actually appear before probing the API, so the
  // GET sees the same committed state the user does.
  await page.getByTestId('monitors-tab-api').click();
  await expect(
    page.locator('tr[data-open][data-type="api"]', { hasText: name }),
  ).toBeVisible({ timeout: 5000 });

  const list = await (await request.get('/api/monitors')).json();
  const created = list.api.find((m: { name: string; id: number }) => m.name === name);
  expect(created).toBeDefined();
  const detail = await (await request.get(`/api/monitors/api/${created.id}`)).json();
  expect(detail.assertions).toHaveLength(0);

  await deleteMonitorViaApi(request, 'api', created.id);
});
