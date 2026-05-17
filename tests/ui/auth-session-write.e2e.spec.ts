import { test, expect, waitForList, ensureSessionAccount, E2E_USER, uniqueSuffix } from './fixtures';

// Regression guard for the v1.3.0 auth bug: a logged-in email/password user
// (session cookie, NO Bearer API key) must be able to perform writes.
// Pre-fix, requireAuth() only accepted `oo_` API keys, so every
// create/update/delete from a cookie session returned 401 — the dashboard
// was non-functional for password users. All writes below go through the
// browser context's request, which carries the session cookie and, crucially,
// no Authorization header.

test('a cookie-session user (no API key) can create and delete a monitor', async ({
  browser,
  request,
}) => {
  const ok = await ensureSessionAccount(request);
  test.skip(
    !ok,
    'stack already has a different admin — use a fresh DB or set OO_E2E_USER_EMAIL/PASSWORD',
  );

  // Fresh context with NO Authorization header — auth is purely the
  // session cookie set by the email/password login.
  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();

  await page.goto('/');
  await page.locator('.login-card input[name="email"]').fill(E2E_USER.email);
  await page.locator('.login-card input[name="password"]').fill(E2E_USER.password);
  await page.locator('.login-card button[type="submit"]').click();
  await waitForList(page);

  const api = ctx.request; // shares the context cookie, sends no Bearer
  const name = `e2e-session-write-${uniqueSuffix()}`;

  const createRes = await api.post('/api/monitors/url', {
    data: {
      name,
      url: 'https://example.com',
      intervalSeconds: 60,
      timeoutMs: 10_000,
      assertions: [{ operator: 'equals', statusCode: 200 }],
    },
  });
  expect(
    createRes.status(),
    `cookie-session POST /api/monitors/url must not 401 (got ${createRes.status()})`,
  ).not.toBe(401);
  expect(createRes.ok()).toBe(true);
  const created = (await createRes.json()) as { id: number };

  const list = await (await api.get('/api/monitors')).json();
  expect(list.url.find((m: { id: number }) => m.id === created.id)).toBeTruthy();

  const delRes = await api.delete(`/api/monitors/url/${created.id}`);
  expect(delRes.ok(), `cookie-session DELETE must succeed (got ${delRes.status()})`).toBe(true);

  const after = await (await api.get('/api/monitors')).json();
  expect(after.url.find((m: { id: number }) => m.id === created.id)).toBeUndefined();

  await ctx.close();
});
