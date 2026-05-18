import { connect } from 'node:net';
import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

// The happy-path tests probe the dev stack's own PG/Redis. On a stack
// where those aren't on the expected port, skip rather than fail noisily
// (same posture as the auth specs' ensureSessionAccount skip).
function reachable(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

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
    test.skip(
      !(await reachable('127.0.0.1', port)),
      `no ${protocol} reachable on 127.0.0.1:${port} — dev stack not up`,
    );
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

// tls=false must behave byte-identically to the shipped plaintext path.
test('redis with tls=false still reports SUCCESS (default-off parity)', async ({
  page,
  request,
}) => {
  test.skip(!(await reachable('127.0.0.1', 6379)), 'no redis on 127.0.0.1:6379 — dev stack not up');
  const name = `e2e-db-tlsfalse-${uniqueSuffix()}`;
  const seedRes = await request.post('/api/monitors/db', {
    data: {
      name,
      protocol: 'redis',
      host: '127.0.0.1',
      port: 6379,
      tls: false,
      intervalSeconds: 60,
      timeoutMs: 5000,
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
    .toBe('SUCCESS');
  await deleteMonitorViaApi(request, 'db', seed.id);
});

// Real TLS redis isn't in CI. Set OO_E2E_TLS_REDIS=host:port (e.g. a
// `redis-server --tls-port 6380` or stunnel) to exercise the TLS path.
test('redis with tls=true against a TLS endpoint reports SUCCESS', async ({ page, request }) => {
  const ep = process.env.OO_E2E_TLS_REDIS;
  const [host, portStr] = (ep ?? '').split(':');
  const port = Number(portStr);
  test.skip(
    !ep || !host || !Number.isInteger(port) || !(await reachable(host, port)),
    'OO_E2E_TLS_REDIS=host:port not set or unreachable — TLS-redis case skipped',
  );
  const name = `e2e-db-tls-${uniqueSuffix()}`;
  const seedRes = await request.post('/api/monitors/db', {
    data: {
      name,
      protocol: 'redis',
      host,
      port,
      tls: true,
      intervalSeconds: 60,
      timeoutMs: 5000,
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
    .toBe('SUCCESS');
  await deleteMonitorViaApi(request, 'db', seed.id);
});
