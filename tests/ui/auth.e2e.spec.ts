import { test, expect, waitForList, ensureSessionAccount, E2E_USER } from './fixtures';

// The "signed-in header" spec uses the project-level Bearer header
// (OO_E2E_API_KEY) so the app boots straight into the dashboard. The
// login-flow specs use a fresh context with NO Bearer header so they
// exercise the real email/password login screen + session cookie.

const SKIP_MSG =
  'stack already has a different admin — use a fresh DB or set OO_E2E_USER_EMAIL/PASSWORD';

test('sign-out button is visible when authenticated', async ({ page, shot }) => {
  await page.goto('/');
  await waitForList(page);
  const signOut = page.locator('#sign-out');
  await expect(signOut).toBeVisible();
  await expect(signOut).toHaveAttribute('title', /sign out/i);
  await shot('header_signed_in');
});

test('login screen accepts a valid email/password and signs the user in', async ({
  browser,
  request,
  shot,
}) => {
  const ok = await ensureSessionAccount(request);
  test.skip(!ok, SKIP_MSG);

  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();

  await page.goto('/');
  await expect(page.getByTestId('login-card')).toBeVisible();
  await expect(page.getByTestId('login-heading')).toHaveText('Sign in');
  await shot('login_screen', page);

  await page.getByTestId('login-card').locator('input[name="email"]').fill(E2E_USER.email);
  await page.getByTestId('login-card').locator('input[name="password"]').fill(E2E_USER.password);
  await page.getByTestId('login-submit').click();

  await waitForList(page);
  await expect(page.locator('#sign-out')).toBeVisible();
  await shot('after_login', page);

  await ctx.close();
});

test('login screen rejects invalid credentials with an inline error', async ({
  browser,
  request,
  shot,
}) => {
  const ok = await ensureSessionAccount(request);
  test.skip(!ok, SKIP_MSG);

  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.getByTestId('login-card')).toBeVisible();

  await page.getByTestId('login-card').locator('input[name="email"]').fill(E2E_USER.email);
  await page.getByTestId('login-card').locator('input[name="password"]').fill('definitely-the-wrong-password');
  await page.getByTestId('login-submit').click();

  await expect(page.getByTestId('login-error')).toBeVisible();
  await expect(page.getByTestId('login-error')).toContainText(/invalid/i);
  await shot('login_invalid', page);

  await ctx.close();
});

test('cookie session persists across reload', async ({ browser, request }) => {
  const ok = await ensureSessionAccount(request);
  test.skip(!ok, SKIP_MSG);

  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();

  await page.goto('/');
  await page.getByTestId('login-card').locator('input[name="email"]').fill(E2E_USER.email);
  await page.getByTestId('login-card').locator('input[name="password"]').fill(E2E_USER.password);
  await page.getByTestId('login-submit').click();
  await waitForList(page);

  // Reload — should NOT bounce back to the login screen.
  await page.reload();
  await waitForList(page);
  await expect(page.getByTestId('login-card')).toHaveCount(0);
  await expect(page.locator('#sign-out')).toBeVisible();

  await ctx.close();
});
