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

const CASES = [
  {
    type: 'url' as const,
    fields: { url: 'https://example.com' },
    timeoutField: 'url_timeout',
    typed: '7',
    expectedMs: 7000,
  },
  {
    type: 'tcp' as const,
    fields: { tcp_host: 'example.com', tcp_port: '443' },
    timeoutField: 'tcp_timeout',
    typed: '9',
    expectedMs: 9000,
  },
];

for (const c of CASES) {
  test(`${c.type.toUpperCase()} timeout — typed value reaches the created monitor`, async ({
    page,
    request,
  }) => {
    await openAddDialog(page, c.type);
    const name = `e2e-timeout-${c.type}-${uniqueSuffix()}`;
    await page.locator('#add-form input[name="name"]').fill(name);
    for (const [field, value] of Object.entries(c.fields)) {
      await page.locator(`#add-form input[name="${field}"]`).fill(value);
    }
    await page.locator(`#add-form input[name="${c.timeoutField}"]`).fill(c.typed);
    await page.getByTestId('add-monitor-submit').click();
    await waitForList(page);

    const id = await findCreatedId(request, c.type, name);
    try {
      expect((await fetchMonitor(request, c.type, id)).timeoutMs).toBe(c.expectedMs);
    } finally {
      await deleteMonitorViaApi(request, c.type, id);
    }
  });
}
