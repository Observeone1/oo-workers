import {
  test,
  expect,
  waitForList,
  uniqueSuffix,
  ensureSessionAccount,
  deleteMonitorViaApi,
} from './fixtures';

// TCP banner/probe-read: the add dialog gained optional payload (hex) and
// expect-banner fields. This asserts the UI→API wiring — the new inputs
// post through and create a monitor carrying them. Probe behaviour itself
// is covered deterministically by scripts/tcp-banner-test.ts.

const HAS_KEY = !!process.env.OO_E2E_API_KEY;

test('add dialog creates a TCP monitor with payload + expect-banner', async ({
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

  const name = `e2e-tcpb-${uniqueSuffix()}`;
  await page.goto('/');
  await waitForList(page);
  await page.locator('#add-btn').click();
  await expect(page.locator('#add-dialog')).toBeVisible();
  await page.locator('#type-select').selectOption('tcp');
  await expect(page.locator('#tcp-row')).toBeVisible();

  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="tcp_host"]').fill('127.0.0.1');
  await page.locator('#add-form input[name="tcp_port"]').fill('6379');
  await page.locator('#add-form input[name="tcp_payload_hex"]').fill('50494e470d0a');
  await page.locator('#add-form input[name="tcp_expect_banner"]').fill('PONG');
  await shot('tcp_banner_dialog');
  await page.locator('#add-form button[type="submit"]').click();

  await waitForList(page);
  await page.locator('.tab[data-tab="tcp"]').click();
  const row = page.locator('tr[data-open][data-type="tcp"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });
  await shot('tcp_banner_list');

  // The new fields actually persisted.
  const list = await (await request.get(`${baseURL}/api/monitors`)).json();
  const created = list.tcp.find((m: { name: string }) => m.name === name) as
    | { id: number; payloadHex: string | null; expectBanner: string | null }
    | undefined;
  expect(created).toBeTruthy();
  expect(created!.payloadHex).toBe('50494e470d0a');
  expect(created!.expectBanner).toBe('PONG');

  await deleteMonitorViaApi(request, 'tcp', created!.id);
});
