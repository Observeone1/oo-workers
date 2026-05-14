import { test, expect, waitForList, uniqueSuffix } from './fixtures';

// Status pages settings + public render (#/status-pages → editor → /status/<slug>).
// The public page is auth-free so we drop the bearer header for the GET to
// prove that path works for anonymous visitors.

test('status pages nav link lands on settings page', async ({ page, shot }) => {
  await page.goto('/');
  await waitForList(page);
  const navLink = page.locator('#status-pages-link');
  await expect(navLink).toBeVisible();
  await navLink.click();
  await page.waitForSelector('.status-pages-page');
  await expect(page.locator('.status-pages-page h2')).toHaveText('Status pages');
  await shot('status_pages_settings_empty');
});

test('create page, bind monitor, view public render, delete', async ({ page, browser, shot }) => {
  const slug = `e2e-${uniqueSuffix()}`;
  await page.goto('/#/status-pages');
  await page.waitForSelector('.status-pages-page', { timeout: 10000 });

  const form = page.locator('#status-page-create-form');
  await form.locator('input[name="slug"]').fill(slug);
  await form.locator('input[name="title"]').fill(`E2E ${slug}`);
  await form.locator('button[type="submit"]').click();

  // Auto-redirect into the editor.
  await page.waitForSelector('.status-page-editor');
  // Pick the first URL monitor.
  await page
    .locator('.status-page-editor input[name="m"][value^="url:"]')
    .first()
    .check();
  await page.locator('.status-page-editor button[type="submit"]').click();
  await expect(page.locator('.banner-ok')).toBeVisible({ timeout: 5000 });

  // Fetch the public page in an UNAUTHENTICATED context — proves no auth required.
  const anonContext = await browser.newContext();
  const anonPage = await anonContext.newPage();
  const res = await anonPage.goto(`/status/${slug}`);
  expect(res?.status()).toBe(200);
  await expect(anonPage.locator('h1')).toHaveText(`E2E ${slug}`);
  await expect(anonPage.locator('.bars').first()).toBeVisible();
  await anonPage.screenshot({
    path: `tests/ui/screenshots/status_page_public_${slug}.png`,
    fullPage: true,
  });
  await anonContext.close();

  // Back to authed editor → navigate to list → delete.
  await page.goto('/#/status-pages');
  await page.waitForSelector('.status-pages-page');
  await expect(page.locator(`.status-page-row[data-slug="${slug}"]`)).toBeVisible();
  page.once('dialog', (d) => d.accept());
  await page.locator(`.status-page-row[data-slug="${slug}"] .status-page-delete`).click();
  await expect(page.locator(`.status-page-row[data-slug="${slug}"]`)).toHaveCount(0, {
    timeout: 5000,
  });

  // Public URL should now 404.
  const anonContext2 = await browser.newContext();
  const anonPage2 = await anonContext2.newPage();
  const res2 = await anonPage2.goto(`/status/${slug}`);
  expect(res2?.status()).toBe(404);
  await anonContext2.close();
  await shot('status_pages_after_delete');
});
