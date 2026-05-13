import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

// DNS query for example.com, A record, tx id 0x1234, recursion desired.
const DNS_QUERY_HEX =
  '1234010000010000000000000765' + '78616d706c6503636f6d0000010001';

test('create UDP monitor through the dialog', async ({ page, request, shot }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-udp-${uniqueSuffix()}`;
  await page.locator('#add-btn').click();
  await expect(page.locator('#add-dialog')).toBeVisible();
  await page.locator('#type-select').selectOption('udp');
  // URL row hides, UDP row + udp-fields show.
  await expect(page.locator('#url-row')).toBeHidden();
  await expect(page.locator('#tcp-row')).toBeHidden();
  await expect(page.locator('#udp-row')).toBeVisible();
  await expect(page.locator('#udp-fields')).toBeVisible();

  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="udp_host"]').fill('8.8.8.8');
  await page.locator('#add-form input[name="udp_port"]').fill('53');
  await page.locator('#add-form input[name="udp_payload_hex"]').fill(DNS_QUERY_HEX);
  await page.locator('#add-form input[name="udp_expect_response"]').check();
  await shot('create_udp_dialog');
  await page.locator('#add-form button[type="submit"]').click();

  await waitForList(page);
  await page.locator('.tab[data-tab="udp"]').click();
  const row = page.locator('tr[data-open][data-type="udp"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  await expect(row.locator('.url')).toContainText('8.8.8.8:53');
  await shot('create_udp_list_after');

  const list = await (await request.get('/api/monitors')).json();
  const created = list.udp.find((m: { name: string; id: number }) => m.name === name);
  if (created) await deleteMonitorViaApi(request, 'udp', created.id);
});

test('UDP Run now executes a DNS query and reports SUCCESS', async ({ page, request, shot }) => {
  const name = `e2e-udp-dns-${uniqueSuffix()}`;
  const seedRes = await request.post('/api/monitors/udp', {
    data: {
      name,
      host: '8.8.8.8',
      port: 53,
      payloadHex: DNS_QUERY_HEX,
      expectResponse: true,
      intervalSeconds: 60,
      timeoutMs: 5000,
    },
  });
  expect(seedRes.ok()).toBe(true);
  const seed = (await seedRes.json()) as { id: number; name: string };

  await page.goto('/');
  await waitForList(page);
  await page.locator('.tab[data-tab="udp"]').click();
  const row = page.locator(`tr[data-open][data-type="udp"][data-id="${seed.id}"]`);
  await row.waitFor();
  await row.locator('button[data-run]').click();

  await expect
    .poll(
      async () => {
        const d = await (await request.get(`/api/monitors/udp/${seed.id}`)).json();
        return d.runs?.[0]?.status ?? null;
      },
      { timeout: 15_000, intervals: [500, 750, 1000] },
    )
    .toBe('SUCCESS');

  await shot('udp_dns_success');
  await deleteMonitorViaApi(request, 'udp', seed.id);
});

test('UDP expect-response with no response marks the run FAILED', async ({ page, request, shot }) => {
  // RFC-5737 reserved IP — won't reply to anything.
  const name = `e2e-udp-noresp-${uniqueSuffix()}`;
  const seedRes = await request.post('/api/monitors/udp', {
    data: {
      name,
      host: '192.0.2.1',
      port: 12345,
      payloadHex: 'deadbeef',
      expectResponse: true,
      intervalSeconds: 60,
      timeoutMs: 1500,
    },
  });
  expect(seedRes.ok()).toBe(true);
  const seed = (await seedRes.json()) as { id: number };

  await page.goto('/');
  await waitForList(page);
  await page.locator('.tab[data-tab="udp"]').click();
  const row = page.locator(`tr[data-open][data-type="udp"][data-id="${seed.id}"]`);
  await row.waitFor();
  await row.locator('button[data-run]').click();

  await expect
    .poll(
      async () => {
        const d = await (await request.get(`/api/monitors/udp/${seed.id}`)).json();
        return d.runs?.[0]?.status ?? null;
      },
      { timeout: 15_000, intervals: [500, 750, 1000] },
    )
    .toBe('FAILED');

  await shot('udp_no_response');
  await deleteMonitorViaApi(request, 'udp', seed.id);
});

test('UDP fire-and-forget (expect_response=false) succeeds without a reply', async ({
  request,
}) => {
  const name = `e2e-udp-fire-${uniqueSuffix()}`;
  const seedRes = await request.post('/api/monitors/udp', {
    data: {
      name,
      host: '192.0.2.1',
      port: 12345,
      payloadHex: 'deadbeef',
      expectResponse: false,
      intervalSeconds: 60,
      timeoutMs: 2000,
    },
  });
  const seed = (await seedRes.json()) as { id: number };

  const run = await request.post(`/api/monitors/udp/${seed.id}/run`);
  expect(run.ok()).toBe(true);

  await expect
    .poll(
      async () => {
        const d = await (await request.get(`/api/monitors/udp/${seed.id}`)).json();
        return d.runs?.[0]?.status ?? null;
      },
      { timeout: 5_000, intervals: [200, 300, 500] },
    )
    .toBe('SUCCESS');

  await deleteMonitorViaApi(request, 'udp', seed.id);
});
