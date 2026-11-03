import { test, expect, waitForList, E2E_USER } from './fixtures';

// First-run setup wizard (src/ui/setup.ts). It has no route of its own:
// boot() renders it at "/" when the DB reports zero users. The screen only
// renders then, and the suite's global-setup
// deliberately preserves auth — so on a lived-in stack there is nothing to
// drive and these skip visibly. On a fresh stack they exercise the real
// browser flow: validate → create the first admin → dashboard. Order
// matters: the validation test runs first because it creates no admin,
// leaving needsSetup true for the happy path that follows. Both use a
// header-free context (no OO_E2E_API_KEY Bearer) so a not-yet-created key
// can't interfere with the first-run routing.
// The wizard creates E2E_USER (not throwaway creds) so the cookie-session
// specs that run after can simply log in.
async function needsFreshSetup(request: import('@playwright/test').APIRequestContext) {
  const res = await request.get('/api/auth/setup-status');
  // An unreachable or erroring stack is a broken environment, not "an admin
  // already exists". Reporting it as such would skip these tests silently on
  // exactly the run that needs them.
  if (!res.ok())
    throw new Error(`setup-status probe failed: ${res.status()} ${res.statusText()}`);
  return ((await res.json()) as { needsSetup: boolean }).needsSetup;
}

const SKIP_MSG = 'stack already has an admin — run against a fresh DB to exercise the setup wizard';

test('setup wizard rejects a short password without leaving the screen', async ({
  browser,
  request,
}) => {
  test.skip(!(await needsFreshSetup(request)), SKIP_MSG);

  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();
  try {
    await page.goto('/');
    await expect(page.getByTestId('setup-card')).toBeVisible();

    await page.locator('#setup-form input[name="name"]').fill('Too Short');
    await page.locator('#setup-form input[name="email"]').fill('short-pass@example.com');
    await page.locator('#setup-form input[name="password"]').fill('abc');
    await page.getByTestId('setup-submit').click();

    // Native minlength validation blocks the submit, so the button's own
    // handler never runs and no server error banner appears. Asserting the
    // banner's ABSENCE is what distinguishes client-side blocking from the
    // server rejecting the same password (which does re-render the card,
    // with setup-error visible) — assert it is present and this test fails.
    await expect(page.getByTestId('setup-card')).toBeVisible();
    await expect(page.getByTestId('setup-error')).toHaveCount(0);
    // No admin was created, so the next (happy-path) test still sees a fresh stack.
    expect(await needsFreshSetup(request)).toBe(true);
  } finally {
    await ctx.close();
  }
});

test('setup wizard creates the first admin and lands on the dashboard', async ({
  browser,
  request,
  shot,
}) => {
  test.skip(!(await needsFreshSetup(request)), SKIP_MSG);

  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();
  try {
    await page.goto('/');
    await expect(page.getByTestId('setup-card')).toBeVisible();
    await expect(page.getByTestId('setup-heading')).toHaveText('Create your account');
    await shot('setup_screen', page);

    await page.locator('#setup-form input[name="name"]').fill(E2E_USER.name);
    await page.locator('#setup-form input[name="email"]').fill(E2E_USER.email);
    await page.locator('#setup-form input[name="password"]').fill(E2E_USER.password);
    await page.getByTestId('setup-submit').click();

    // Successful setup reloads into the app as the new admin.
    await waitForList(page);
    await expect(page.locator('#sign-out')).toBeVisible();
    await shot('setup_complete', page);
  } finally {
    await ctx.close();
  }
});
