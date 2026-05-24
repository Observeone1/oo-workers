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
//
// v2 (post-settings split): API keys live under Settings → API keys,
// reached via the header gear button. Create flow uses a slideover, not
// an inline form.

test('create a key in the UI, use it, revoke it, and confirm it 401s', async ({
  browser,
  request,
}) => {
  test.setTimeout(90_000);
  const ok = await ensureSessionAccount(request);
  test.skip(
    !ok,
    'stack already has a different admin — use a fresh DB or set OO_E2E_USER_EMAIL/PASSWORD',
  );

  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();

  // Sign in (cookie session), then navigate to Settings → API keys.
  await page.goto('/');
  await page.getByTestId('login-card').locator('input[name="email"]').fill(E2E_USER.email);
  await page.getByTestId('login-card').locator('input[name="password"]').fill(E2E_USER.password);
  await page.getByTestId('login-submit').click();
  await waitForList(page);

  await page.goto('/#/settings');
  await page.getByTestId('settings-tab-keys').click();
  await expect(page.getByTestId('keys-add-btn')).toBeVisible();

  // Create a write key via the slideover.
  const name = `e2e-key-${uniqueSuffix()}`;
  await page.getByTestId('keys-add-btn').click();
  await expect(page.getByTestId('slideover')).toBeVisible();
  await page.getByTestId('keys-name-input').fill(name);
  // Write scope is checked by default — leave it.
  await page.getByTestId('slideover-primary').click();

  // One-time reveal panel shows the freshly created cleartext key.
  const keyValue = page.getByTestId('key-cleartext');
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

  // Dismiss the one-time reveal, then revoke via the row action.
  await page.getByTestId('keys-dismiss-btn').click();
  const row = page.locator(`tr[data-name="${name}"]`);
  await row.getByTestId('key-revoke-btn').click();
  await page.getByTestId('confirm-ok').click();
  await expect(row).toHaveClass(/revoked/);
  await expect(row.getByTestId('key-revoke-btn')).toHaveCount(0);

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
