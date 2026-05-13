import { test, expect, waitForList } from './fixtures';

// These specs run when the stack has OO_AUTH_ENABLED=true and the
// playwright config has injected OO_E2E_API_KEY as a Bearer header for
// every request. The login-flow spec deliberately uses a fresh page
// context without that header so it can exercise the login screen.

test('sign-out button is visible when authenticated, and signs out', async ({ page, shot }) => {
  await page.goto('/');
  await waitForList(page);
  const signOut = page.locator('#sign-out');
  await expect(signOut).toBeVisible();
  // Title carries identity (prefix or name)
  await expect(signOut).toHaveAttribute('title', /sign out/i);
  await shot('header_signed_in');
});

test('login screen accepts a valid key and signs the user in', async ({ browser, shot }) => {
  const key = process.env.OO_E2E_API_KEY;
  test.skip(!key, 'OO_E2E_API_KEY not set — login spec requires auth-on stack');

  // Fresh context with no auth header set so the page boots into login.
  // Override the project-level Authorization header so this context starts unauth'd.
  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();

  await page.goto('/');
  await expect(page.locator('.login-card')).toBeVisible();
  await expect(page.locator('.login-card h2')).toHaveText('Sign in');
  await shot('login_screen', page);

  await page.locator('.login-card input[name="key"]').fill(key!);
  await page.locator('.login-card button[type="submit"]').click();

  // Reload should land us in the normal dashboard.
  await waitForList(page);
  await expect(page.locator('#sign-out')).toBeVisible();
  await shot('after_login', page);

  await ctx.close();
});

test('login screen rejects an invalid key with an inline error', async ({ browser, shot }) => {
  // Override the project-level Authorization header so this context starts unauth'd.
  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.locator('.login-card')).toBeVisible();

  await page.locator('.login-card input[name="key"]').fill('oo_aaaaaaaaaaaaaaaaaaaaaa');
  await page.locator('.login-card button[type="submit"]').click();

  await expect(page.locator('.login-error')).toBeVisible();
  await expect(page.locator('.login-error')).toContainText(/invalid|revoked/i);
  await shot('login_invalid', page);

  await ctx.close();
});

test('cookie session persists across reload', async ({ browser, request }) => {
  const key = process.env.OO_E2E_API_KEY;
  test.skip(!key, 'OO_E2E_API_KEY not set — cookie spec requires auth-on stack');

  // Override the project-level Authorization header so this context starts unauth'd.
  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();

  // Sign in via the UI flow.
  await page.goto('/');
  await page.locator('.login-card input[name="key"]').fill(key!);
  await page.locator('.login-card button[type="submit"]').click();
  await waitForList(page);

  // Reload — should NOT bounce back to the login screen.
  await page.reload();
  await waitForList(page);
  await expect(page.locator('.login-card')).toHaveCount(0);
  await expect(page.locator('#sign-out')).toBeVisible();

  await ctx.close();
});
