import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

// DB protocol checks — credential-free liveness. The dev stack's own
// Postgres (127.0.0.1:5442) and Redis (127.0.0.1:6379) are live, so a
// real probe against them returns SUCCESS with zero fixture setup. MySQL
// has no local instance in the dev stack — that path is covered by the
// "closed port → FAILED" case rather than a skipped happy path.

test('create DB monitor through the dialog (protocol picker)', async ({ page, request, shot }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-db-${uniqueSuffix()}`;
  await page.locator('#add-btn').click();
  await expect(page.locator('#add-dialog')).toBeVisible();
  await page.locator('#type-select').selectOption('db');
  await expect(page.locator('#url-row')).toBeHidden();
  await expect(page.locator('#db-row')).toBeVisible();

  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form select[name="db_protocol"]').selectOption('postgres');
  await page.locator('#add-form input[name="db_host"]').fill('127.0.0.1');
  await page.locator('#add-form input[name="db_port"]').fill('5442');
  await shot('create_db_dialog');
  await page.locator('#add-form button[type="submit"]').click();

  await waitForList(page);
  await page.locator('.tab[data-tab="db"]').click();
  const row = page.locator('tr[data-open][data-type="db"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row.locator('.url')).toContainText('postgres 127.0.0.1:5442');
  await shot('create_db_list_after');

  const list = await (await request.get('/api/monitors')).json();
  const created = list.db.find((m: { name: string; id: number }) => m.name === name);
  if (created) await deleteMonitorViaApi(request, 'db', created.id);
});

for (const { protocol, port } of [
  { protocol: 'postgres', port: 5442 },
  { protocol: 'redis', port: 6379 },
] as const) {
  test(`${protocol} Run now against the live local instance reports SUCCESS`, async ({
    page,
    request,
    shot,
  }) => {
    const name = `e2e-db-${protocol}-${uniqueSuffix()}`;
    const seedRes = await request.post('/api/monitors/db', {
      data: { name, protocol, host: '127.0.0.1', port, intervalSeconds: 60, timeoutMs: 5000 },
    });
    expect(seedRes.ok()).toBe(true);
    const seed = (await seedRes.json()) as { id: number };

    await page.goto('/');
    await waitForList(page);
    await page.locator('.tab[data-tab="db"]').click();
    const row = page.locator(`tr[data-open][data-type="db"][data-id="${seed.id}"]`);
    await row.waitFor();
    await row.locator('button[data-run]').click();

    await expect
      .poll(
        async () => {
          const d = await (await request.get(`/api/monitors/db/${seed.id}`)).json();
          return d.runs?.[0]?.status ?? null;
        },
        { timeout: 15_000, intervals: [500, 750, 1000] },
      )
      .toBe('SUCCESS');

    await shot(`db_${protocol}_success`);
    await deleteMonitorViaApi(request, 'db', seed.id);
  });
}

test('DB monitor against a closed port reports FAILED', async ({ page, request, shot }) => {
  const name = `e2e-db-down-${uniqueSuffix()}`;
  // RFC-5737 reserved IP — connect will time out (nothing answers).
  const seedRes = await request.post('/api/monitors/db', {
    data: {
      name,
      protocol: 'mysql',
      host: '192.0.2.1',
      port: 3306,
      intervalSeconds: 60,
      timeoutMs: 1500,
    },
  });
  expect(seedRes.ok()).toBe(true);
  const seed = (await seedRes.json()) as { id: number };

  await page.goto('/');
  await waitForList(page);
  await page.locator('.tab[data-tab="db"]').click();
  const row = page.locator(`tr[data-open][data-type="db"][data-id="${seed.id}"]`);
  await row.waitFor();
  await row.locator('button[data-run]').click();

  await expect
    .poll(
      async () => {
        const d = await (await request.get(`/api/monitors/db/${seed.id}`)).json();
        return d.runs?.[0]?.status ?? null;
      },
      { timeout: 15_000, intervals: [500, 750, 1000] },
    )
    .toBe('FAILED');

  await shot('db_down');
  await deleteMonitorViaApi(request, 'db', seed.id);
});
