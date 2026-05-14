import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Tour spec — captures one full-page PNG per shipped UI surface into
// SCREENSHOT_OUT_DIR (default: research repo). Read-only against
// whatever's in the DB; skips steps that need data we don't have.
//
// Run:
//   OO_E2E_API_KEY=<key> bun playwright test tests/ui/screenshot-tour.e2e.spec.ts \
//     --config=playwright.ui.config.ts

const OUT_DIR = resolve(
  process.env.SCREENSHOT_OUT_DIR ??
    '/home/samir/observeone/Observeone-research/engineering-and-product/oo-workers-status/screenshots',
);

mkdirSync(OUT_DIR, { recursive: true });

const shot = async (page: import('@playwright/test').Page, name: string) => {
  await page.screenshot({ path: join(OUT_DIR, name), fullPage: true });
};

const waitForList = async (page: import('@playwright/test').Page) => {
  await page.waitForSelector('.tab[data-tab="url"]', { timeout: 10_000 });
};

test.describe.configure({ mode: 'serial' });

test('01 login', async ({ browser }) => {
  const key = process.env.OO_E2E_API_KEY;
  test.skip(!key, 'OO_E2E_API_KEY required for login render');
  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();
  await page.goto('/');
  await expect(page.locator('.login-card')).toBeVisible();
  await shot(page, '01-login.png');
  await ctx.close();
});

test('02 dashboard', async ({ page }) => {
  await page.goto('/');
  await waitForList(page);
  await shot(page, '02-dashboard-light.png');
});

test('07 add monitor dialog', async ({ page }) => {
  await page.goto('/');
  await waitForList(page);
  await page.locator('#add-btn').click();
  await expect(page.locator('#add-dialog')).toBeVisible();
  await shot(page, '07-add-monitor-dialog.png');
});

test('11 import dialog', async ({ page }) => {
  await page.goto('/');
  await waitForList(page);
  await page.locator('#import-btn').click();
  await expect(page.locator('#import-dialog')).toBeVisible();
  await shot(page, '11-import-dialog.png');
});

test('12 monitor detail', async ({ page }) => {
  await page.goto('/');
  await waitForList(page);
  const firstRow = page.locator('tr[data-open]').first();
  if (await firstRow.count()) {
    await firstRow.click();
    await page.waitForSelector('.back-link', { timeout: 5_000 });
    await shot(page, '12-monitor-detail.png');
  } else {
    test.skip(true, 'no monitors in DB');
  }
});

test('14 regions', async ({ page }) => {
  await page.goto('/#/regions');
  await page.waitForSelector('.regions-page', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot(page, '14-regions.png');
});

test('15 channels', async ({ page }) => {
  await page.goto('/#/channels');
  await page.waitForSelector('.channels-page', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot(page, '15-channels.png');
});

test('16 status pages', async ({ page }) => {
  await page.goto('/#/status-pages');
  await page.waitForSelector('.status-pages-page', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot(page, '16-status-pages.png');
});

test('16b status page public', async ({ browser }) => {
  // Anonymous context — public page must render without bearer.
  const ctx = await browser.newContext({ extraHTTPHeaders: {} });
  const page = await ctx.newPage();
  await page.goto('/status/demo');
  await page.waitForSelector('h1', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot(page, '16b-status-page-public.png');
  await ctx.close();
});

test('19 qa artifacts', async ({ page }) => {
  // Requires a QA monitor with at least one failed run that has trace +
  // screenshot uploaded. Seed via the demo script
  // (/tmp/seed-artifacts-demo.ts) if none exist. Skips if no QA monitor
  // detail page is reachable.
  const projectId = Number(process.env.SCREENSHOT_QA_PROJECT_ID ?? '0');
  test.skip(!projectId, 'set SCREENSHOT_QA_PROJECT_ID to a seeded QA project id');
  await page.goto(`/#/qa/${projectId}`);
  await page.waitForSelector('a.artifact-link', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await shot(page, '19-qa-artifacts.png');
});

test('17 docs in-app', async ({ page }) => {
  await page.goto('/#/docs');
  await page.waitForSelector('#main .docs-embed h1, #main .docs-embed h2', { timeout: 10_000 });
  await page.waitForTimeout(300);
  await shot(page, '17-docs.png');
});
