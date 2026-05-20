import { request as pwRequest } from '@playwright/test';
import {
  test,
  expect,
  waitForList,
  ensureSessionAccount,
  E2E_USER,
  uniqueSuffix,
} from './fixtures';

// Batch 4 regression: the API-key management UI must mint a working key,
// and revoking it must take effect immediately. The keyed request context
// carries NO session cookie, so a post-revoke 401 can't be masked by the
// session fallback in requireAuth.

test('create a key in the UI, use it, revoke it, and confirm it 401s', async ({
  browser,
  request,
}) => {
  const ok = await ensureSessionAccount(request);
  test.skip(
    !ok,
    'stack already has a different admin — use a fresh DB or set OO_E2E_USER_EMAIL/PASSWORD',
  );

  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();

  // Sign in (cookie session), then open the Keys page.
  await page.goto('/');
  await page.getByTestId('login-card').locator('input[name="email"]').fill(E2E_USER.email);
  await page.getByTestId('login-card').locator('input[name="password"]').fill(E2E_USER.password);
  await page.getByTestId('login-submit').click();
  await waitForList(page);

  await page.locator('#keys-link').click();
  await expect(page.locator('#key-create-form')).toBeVisible();

  // Create a write key via the form (write scope checked by default).
  const name = `e2e-key-${uniqueSuffix()}`;
  await page.locator('#key-create-form input[name="name"]').fill(name);
  await page.locator('#key-create-form button[type="submit"]').click();

  const keyValue = page.locator('.one-time-key-value code');
  await expect(keyValue).toBeVisible();
  const cleartext = (await keyValue.textContent())?.trim() ?? '';
  expect(cleartext.startsWith('oo_')).toBe(true);

  // A clean context: ONLY the Bearer key, no session cookie.
  const origin = new URL(page.url()).origin;
  const keyApi = await pwRequest.newContext({
    baseURL: origin,
    extraHTTPHeaders: { Authorization: `Bearer ${cleartext}` },
  });

  const monName = `e2e-key-mon-${uniqueSuffix()}`;
  const createRes = await keyApi.post('/api/monitors/url', {
    data: {
      name: monName,
      url: 'https://example.com',
      intervalSeconds: 60,
      timeoutMs: 10_000,
      assertions: [{ operator: 'equals', statusCode: 200 }],
    },
  });
  expect(createRes.ok(), `fresh key write must succeed (got ${createRes.status()})`).toBe(true);
  const created = (await createRes.json()) as { id: number };

  // Revoke via the UI, dismiss the one-time panel first.
  await page.locator('#dismiss-key-btn').click();
  const row = page.locator(`.region-row[data-name="${name}"]`);
  await row.locator('.key-revoke').click();
  await page.locator('#confirm-dialog .confirm-ok').click();
  await expect(row).toHaveClass(/revoked/);
  await expect(row.locator('.key-revoke')).toHaveCount(0);

  // Same key, same write — now rejected.
  const afterRevoke = await keyApi.post('/api/monitors/url', {
    data: {
      name: `${monName}-2`,
      url: 'https://example.com',
      intervalSeconds: 60,
      timeoutMs: 10_000,
      assertions: [{ operator: 'equals', statusCode: 200 }],
    },
  });
  expect(afterRevoke.status(), 'revoked key must 401').toBe(401);

  // Cleanup the monitor via the still-valid session cookie.
  await ctx.request.delete(`/api/monitors/url/${created.id}`).catch(() => {});

  await keyApi.dispose();
  await ctx.close();
});
