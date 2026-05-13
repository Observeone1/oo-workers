import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

test('Import JSON dialog accepts a payload and creates the rows', async ({
  page,
  request,
  shot,
}) => {
  const suffix = uniqueSuffix();
  const payload = {
    version: 1,
    urlMonitors: [
      {
        name: `imp-url-${suffix}`,
        url: 'https://example.com',
        intervalSeconds: 60,
        timeoutMs: 10_000,
        assertions: [{ operator: 'equals', statusCode: 200 }],
      },
    ],
    apiChecks: [],
    qaProjects: [],
  };

  await page.goto('/');
  await waitForList(page);

  await page.locator('#import-btn').click();
  await expect(page.locator('#import-dialog')).toBeVisible();
  await page.locator('#import-text').fill(JSON.stringify(payload, null, 2));
  await shot('import_dialog');

  // The submit handler ends with `alert(...)`; auto-accept it.
  page.once('dialog', (d) => d.accept().catch(() => {}));
  await page.locator('#import-submit').click();

  await waitForList(page);
  const row = page.locator('tr[data-open][data-type="url"]', {
    hasText: `imp-url-${suffix}`,
  });
  await expect(row).toBeVisible({ timeout: 5000 });
  await shot('import_list_after');

  // Cleanup.
  const list = await (await request.get('/api/monitors')).json();
  const created = list.url.find((m: { name: string; id: number }) => m.name === `imp-url-${suffix}`);
  if (created) await deleteMonitorViaApi(request, 'url', created.id);
});
