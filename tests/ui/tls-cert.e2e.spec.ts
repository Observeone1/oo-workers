import {
  test,
  expect,
  waitForList,
  uniqueSuffix,
  ensureSessionAccount,
  deleteMonitorViaApi,
} from './fixtures';

// TLS cert-expiry: the add dialog gained a type=tls option with its own
// host/port/servername/warn-days row. This asserts the UI→API wiring —
// the new inputs post through and create a monitor carrying them. Probe
// behaviour (expiry → SUCCESS/FAILED) is covered deterministically by
// scripts/tls-cert-test.ts.

const HAS_KEY = !!process.env.OO_E2E_API_KEY;

test('add dialog creates a TLS monitor with host/port/warn-days', async ({
  page,
  request,
  baseURL,
  shot,
}) => {
  if (!HAS_KEY) {
    test.skip(
      !(await ensureSessionAccount(request)),
      'no usable auth — set OO_E2E_API_KEY or use a fresh stack',
    );
  }

  const name = `e2e-tls-${uniqueSuffix()}`;
  await page.goto('/');
  await waitForList(page);
  await page.locator('#add-btn').click();
  await expect(page.locator('#add-dialog')).toBeVisible();
  await page.locator('#type-select').selectOption('tls');
  await expect(page.locator('#tls-row')).toBeVisible();

  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="tls_host"]').fill('example.com');
  await page.locator('#add-form input[name="tls_port"]').fill('443');
  await page.locator('#add-form input[name="tls_warn_days"]').fill('30');
  await shot('tls_cert_dialog');
  await page.locator('#add-form button[type="submit"]').click();

  await waitForList(page);
  await page.locator('.tab[data-tab="tls"]').click();
  const row = page.locator('tr[data-open][data-type="tls"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  await shot('tls_cert_list');

  // The new fields actually persisted.
  const list = await (await request.get(`${baseURL}/api/monitors`)).json();
  const created = list.tls.find((m: { name: string }) => m.name === name) as
    | { id: number; host: string; port: number; warnDays: number }
    | undefined;
  expect(created).toBeTruthy();
  expect(created!.host).toBe('example.com');
  expect(created!.port).toBe(443);
  expect(created!.warnDays).toBe(30);

  await deleteMonitorViaApi(request, 'tls', created!.id);
});
