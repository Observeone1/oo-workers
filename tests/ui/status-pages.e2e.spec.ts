import { test, expect, waitForList, uniqueSuffix } from './fixtures';

// Status pages settings + public render (#/status-pages → editor → /status/<slug>).
// The public page is auth-free so we drop the bearer header for the GET to
// prove that path works for anonymous visitors.

test('status pages nav link lands on settings page', async ({ page, shot }) => {
  await page.goto('/');
  await waitForList(page);
  const navLink = page.getByTestId('nav-status-pages');
  await expect(navLink).toBeVisible();
  await navLink.click();
  await expect(page.getByTestId('page-title')).toHaveText('Status pages');
  await shot('status_pages_settings_empty');
});

test('create page, bind monitor, view public render, delete', async ({ page, browser, shot }) => {
  const slug = `e2e-${uniqueSuffix()}`;
  await page.goto('/#/status-pages');
  await expect(page.getByTestId('page-title')).toHaveText('Status pages');

  // v2: create moved into a slideover (was inline #status-page-create-form).
  await page.getByTestId('sp-add-btn').click();
  const so = page.getByTestId('slideover');
  await expect(so).toBeVisible();
  await so.locator('#so-sp-title').fill(`E2E ${slug}`);
  await so.locator('#so-sp-slug').fill(slug);
  await page.getByTestId('slideover-primary').click();

  // Auto-redirect into the editor at #/status-pages/<id>. Editor form id
  // is stable (#status-page-edit-form).
  await page.waitForSelector('#status-page-edit-form', { timeout: 10_000 });
  // Pick the first URL monitor.
  await page
    .locator('#status-page-edit-form input[name="m"][value^="url:"]')
    .first()
    .check();
  await page.locator('#status-page-edit-form button[type="submit"]').click();
  await expect(page.getByTestId('banner-ok')).toBeVisible({ timeout: 5000 });

  // Fetch the public page in an UNAUTHENTICATED context — proves no auth required.
  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();
  const res = await anonPage.goto(`/status/${slug}`);
  expect(res?.status()).toBe(200);
  await expect(anonPage.locator('h1')).toHaveText(`E2E ${slug}`);
  // Public page renders a .monitor block per bound monitor with a
  // .bars container; bars90d is always 90 elements (unknown-filled
  // when there are no runs yet). Use count instead of toBeVisible
  // because freshly-bound monitors may have 0-height bars.
  await expect(anonPage.locator('.bars')).toHaveCount(1);
  await expect(anonPage.locator('.monitor-name')).toHaveCount(1);
  await anonPage.screenshot({
    path: `tests/ui/screenshots/status_page_public_${slug}.png`,
    fullPage: true,
  });
  await anonContext.close();

  // Back to authed editor → navigate to list → delete via the active
  // page's Delete button (v2 confirms via the in-app confirm dialog).
  await page.goto('/#/status-pages');
  await expect(page.getByTestId('page-title')).toHaveText('Status pages');
  // Click the sp-item to make it active. renderList re-fetches detail
  // async — wait for the active class to land so sp-delete-btn refers
  // to OUR page, not whichever was previously active.
  const newSpItem = page.getByTestId(`sp-item-${slug}`);
  await newSpItem.click();
  await expect(newSpItem).toHaveClass(/active/);
  await page.getByTestId('sp-delete-btn').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId(`sp-item-${slug}`)).toHaveCount(0, { timeout: 5000 });

  // Public URL should now 404.
  const anonContext2 = await browser.newContext();
  const anonPage2 = await anonContext2.newPage();
  const res2 = await anonPage2.goto(`/status/${slug}`);
  expect(res2?.status()).toBe(404);
  await anonContext2.close();
  await shot('status_pages_after_delete');
});
