/**
 * Repro tests for the dead Timeout fields in the add-monitor dialog.
 *
 * Before the fix, the TCP Timeout input had no `name` attribute and the URL
 * Timeout value was never read on submit, so both dialogs silently dropped
 * what the operator typed and the server defaults applied (URL 30s, TCP 5s).
 * These tests type a non-default timeout, submit, fetch the created monitor
 * and assert timeoutMs matches what was entered. Both fail on the old code.
 */

import {
  test,
  expect,
  waitForList,
  uniqueSuffix,
  deleteMonitorViaApi,
  fetchMonitor,
  findCreatedId,
  openAddDialog,
} from './fixtures';

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
    expect((await fetchMonitor(request, 'url', id)).timeoutMs).toBe(7000);
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
    expect((await fetchMonitor(request, 'tcp', id)).timeoutMs).toBe(9000);
  } finally {
    await deleteMonitorViaApi(request, 'tcp', id);
  }
});
