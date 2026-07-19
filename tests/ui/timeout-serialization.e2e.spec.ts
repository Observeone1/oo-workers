/**
 * Repro tests for the dead Timeout fields in the add-monitor dialog.
 *
 * Before the fix, the TCP Timeout input had no `name` attribute and the URL
 * Timeout value was never read on submit, so both dialogs silently dropped
 * what the operator typed and the server defaults applied (URL 30s, TCP 5s).
 * These tests type a non-default timeout, submit, fetch the created monitor
 * and assert timeoutMs matches what was entered. Both fail on the old code.
 */

import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';
import type { Page, APIRequestContext } from '@playwright/test';

async function fetchTimeoutMs(
  request: APIRequestContext,
  type: 'url' | 'tcp',
  id: number,
): Promise<number> {
  const res = await request.get(`/api/monitors/${type}/${id}`);
  expect(res.ok(), `GET /api/monitors/${type}/${id} failed: ${res.status()}`).toBe(true);
  const body = (await res.json()) as { monitor: { timeoutMs: number } };
  return body.monitor.timeoutMs;
}

async function findCreatedId(
  request: APIRequestContext,
  type: 'url' | 'tcp',
  name: string,
): Promise<number> {
  const list = (await (await request.get('/api/monitors')).json()) as Record<
    string,
    Array<{ id: number; name: string }>
  >;
  const row = list[type].find((m) => m.name === name);
  expect(row, `monitor '${name}' not found in /api/monitors[${type}]`).toBeDefined();
  return row!.id;
}

async function openAddDialog(page: Page, tile: 'url' | 'tcp'): Promise<void> {
  await page.goto('/');
  await waitForList(page);
  await page.getByTestId('header-add-monitor-btn').click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  await page.getByTestId(`add-monitor-type-tile-${tile}`).click();
}

test('URL timeout — typed value reaches the created monitor', async ({ page, request }) => {
  await openAddDialog(page, 'url');
  const name = `e2e-timeout-url-${uniqueSuffix()}`;
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="url"]').fill('https://example.com');
  await page.locator('#add-form input[name="url_timeout"]').fill('7');
  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  const id = await findCreatedId(request, 'url', name);
  try {
    expect(await fetchTimeoutMs(request, 'url', id)).toBe(7000);
  } finally {
    await deleteMonitorViaApi(request, 'url', id);
  }
});

test('TCP timeout — typed value reaches the created monitor', async ({ page, request }) => {
  await openAddDialog(page, 'tcp');
  const name = `e2e-timeout-tcp-${uniqueSuffix()}`;
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="tcp_host"]').fill('example.com');
  await page.locator('#add-form input[name="tcp_port"]').fill('443');
  await page.locator('#add-form input[name="tcp_timeout"]').fill('9');
  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  const id = await findCreatedId(request, 'tcp', name);
  try {
    expect(await fetchTimeoutMs(request, 'tcp', id)).toBe(9000);
  } finally {
    await deleteMonitorViaApi(request, 'tcp', id);
  }
});
