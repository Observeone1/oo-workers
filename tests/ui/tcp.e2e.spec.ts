import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

test('create TCP monitor through the dialog', async ({ page, request, shot }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-tcp-${uniqueSuffix()}`;
  await page.locator('#add-btn').click();
  await expect(page.locator('#add-dialog')).toBeVisible();
  await page.locator('#type-select').selectOption('tcp');
  // URL row hides, TCP row shows.
  await expect(page.locator('#url-row')).toBeHidden();
  await expect(page.locator('#tcp-row')).toBeVisible();

  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="tcp_host"]').fill('example.com');
  await page.locator('#add-form input[name="tcp_port"]').fill('443');
  await shot('create_tcp_dialog');
  await page.locator('#add-form button[type="submit"]').click();

  await waitForList(page);
  await page.locator('.tab[data-tab="tcp"]').click();
  const row = page.locator('tr[data-open][data-type="tcp"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  // Row shows host:port in the URL column.
  await expect(row.locator('.url')).toContainText('example.com:443');
  await shot('create_tcp_list_after');

  const list = await (await request.get('/api/monitors')).json();
  const created = list.tcp.find((m: { name: string; id: number }) => m.name === name);
  if (created) await deleteMonitorViaApi(request, 'tcp', created.id);
});

test('TCP Run now executes and reports SUCCESS', async ({ page, request, shot }) => {
  // Seed via API for a deterministic row to act on.
  const name = `e2e-tcp-run-${uniqueSuffix()}`;
  const seedRes = await request.post('/api/monitors/tcp', {
    data: { name, host: 'example.com', port: 443, intervalSeconds: 60, timeoutMs: 5000 },
  });
  expect(seedRes.ok()).toBe(true);
  const seed = (await seedRes.json()) as { id: number; name: string };

  await page.goto('/');
  await waitForList(page);
  await page.locator('.tab[data-tab="tcp"]').click();
  const row = page.locator(`tr[data-open][data-type="tcp"][data-id="${seed.id}"]`);
  await row.waitFor();
  await row.locator('button[data-run]').click();

  await expect
    .poll(
      async () => {
        const d = await (await request.get(`/api/monitors/tcp/${seed.id}`)).json();
        return d.runs?.[0]?.status ?? null;
      },
      { timeout: 15_000, intervals: [500, 750, 1000] },
    )
    .toBe('SUCCESS');

  await shot('tcp_after_run_now');
  await deleteMonitorViaApi(request, 'tcp', seed.id);
});

test('TCP timeout case marks the run FAILED', async ({ page, request, shot }) => {
  // Reserved/discard IP 192.0.2.1 is guaranteed by RFC 5737 to not be reachable.
  // Pair with a tiny timeout so the run fails within e2e budget.
  const name = `e2e-tcp-timeout-${uniqueSuffix()}`;
  const seedRes = await request.post('/api/monitors/tcp', {
    data: { name, host: '192.0.2.1', port: 9, intervalSeconds: 60, timeoutMs: 1000 },
  });
  expect(seedRes.ok()).toBe(true);
  const seed = (await seedRes.json()) as { id: number };

  await page.goto('/');
  await waitForList(page);
  await page.locator('.tab[data-tab="tcp"]').click();
  const row = page.locator(`tr[data-open][data-type="tcp"][data-id="${seed.id}"]`);
  await row.waitFor();
  await row.locator('button[data-run]').click();

  await expect
    .poll(
      async () => {
        const d = await (await request.get(`/api/monitors/tcp/${seed.id}`)).json();
        return d.runs?.[0]?.status ?? null;
      },
      { timeout: 15_000, intervals: [500, 750, 1000] },
    )
    .toBe('FAILED');

  await shot('tcp_after_timeout');
  await deleteMonitorViaApi(request, 'tcp', seed.id);
});
