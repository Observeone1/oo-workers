import { test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { deleteMonitorViaApi } from './fixtures';

/**
 * Captures the 5 hero surfaces for the /workers landing page in both
 * themes. Each shot is a viewport-sized PNG (NOT full-page) so the
 * Features grid renders them in a sensible aspect ratio.
 *
 *   Dashboard / Add-monitor / Heartbeat detail / Regions / Channels
 *     ×
 *   light theme / dark theme
 *
 * Output: landing-page-nextjs/public/screenshots/workers/{light,dark}/
 * (relative path resolved from the cwd; override via
 *  WORKERS_LANDING_SCREENSHOT_OUT_DIR).
 *
 * Anti-vacuous: each shot asserts a meaningful element is visible before
 * capturing. Adding a token without restarting the worker would fail the
 * heartbeat detail wait.
 *
 * Run from oo-workers root with the dev stack on :3010:
 *   OO_E2E_API_KEY=<key> bun playwright test \
 *     --config=playwright.ui.config.ts \
 *     tests/ui/workers-landing-tour.e2e.spec.ts
 */

const OUT_DIR =
  process.env.WORKERS_LANDING_SCREENSHOT_OUT_DIR ??
  '/home/samir/observeone/projects/observeone-landing-page-nextjs/public/screenshots/workers';

mkdirSync(join(OUT_DIR, 'light'), { recursive: true });
mkdirSync(join(OUT_DIR, 'dark'), { recursive: true });

type Theme = 'light' | 'dark';
const THEMES: Theme[] = ['light', 'dark'];

// Browser-level injection: stamp localStorage BEFORE the SPA's initTheme
// runs, so the dashboard hydrates in the requested theme. addInitScript
// hooks into every navigation/reload in the page lifetime.
async function applyTheme(page: import('@playwright/test').Page, theme: Theme) {
  await page.addInitScript((t) => {
    localStorage.setItem('oo-workers:theme', t);
  }, theme);
}

async function shot(
  page: import('@playwright/test').Page,
  theme: Theme,
  name: string,
) {
  await page.screenshot({
    path: join(OUT_DIR, theme, `${name}.png`),
    fullPage: false,
  });
}

// Realistic-looking seed data so the dashboard / regions / channels
// screenshots aren't empty states. All names get a `landing-tour-`
// prefix so the global-setup purge wouldn't touch them mid-run, and
// afterAll deletes them itself.
const seeded: Array<{ type: 'url' | 'api' | 'heartbeat'; id: number }> = [];
const seededChannelIds: number[] = [];
let seededHeartbeatId: number | null = null;

test.beforeAll(async ({ request }) => {
  // No "landing-tour-" prefix so the screenshots look like a real
  // operator's dashboard. afterAll deletes by collected id, not name
  // prefix, so the rows are still safe to clean up.
  const urlSeeds = [
    { name: 'api-health', url: 'https://api.example.com/health' },
    { name: 'marketing-site', url: 'https://www.example.com' },
    { name: 'dashboard', url: 'https://app.example.com' },
  ];
  for (const s of urlSeeds) {
    const r = await request.post('/api/monitors/url', {
      data: {
        name: s.name,
        url: s.url,
        intervalSeconds: 60,
        timeoutMs: 10_000,
        assertions: [{ operator: 'equals', statusCode: 200 }],
      },
    });
    if (r.ok()) {
      const b = (await r.json()) as { id: number };
      seeded.push({ type: 'url', id: b.id });
    }
  }

  const apiSeed = await request.post('/api/monitors/api', {
    data: {
      name: 'checkout-api',
      url: 'https://api.example.com/v1/checkout',
      method: 'POST',
      intervalSeconds: 60,
      assertions: [{ type: 'status', operator: 'equals', value: 200 }],
    },
  });
  if (apiSeed.ok()) {
    const b = (await apiSeed.json()) as { id: number };
    seeded.push({ type: 'api', id: b.id });
  }

  const heartbeat = await request.post('/api/monitors/heartbeat', {
    data: {
      name: 'nightly-backup',
      description: 'Cron heartbeat for the nightly backup job',
      periodSeconds: 3600,
      graceSeconds: 300,
    },
  });
  if (heartbeat.ok()) {
    const b = (await heartbeat.json()) as { id: number };
    seededHeartbeatId = b.id;
    seeded.push({ type: 'heartbeat', id: b.id });
  }

  // Channels — wire-shape is flat {name,type,url} per /api/channels
  // POST handler (server.ts:1319). For email, the `url` field carries
  // the recipient address; for webhook/slack/discord it's the hook URL.
  const channelSeeds = [
    { name: 'ops-email', type: 'email', url: 'ops@example.com' },
    {
      name: 'oncall-slack',
      type: 'slack',
      url: 'https://hooks.slack.com/services/T00/B00/xxx',
    },
    {
      name: 'p1-discord',
      type: 'discord',
      url: 'https://discord.com/api/webhooks/0/xxx',
    },
  ];
  for (const ch of channelSeeds) {
    const r = await request.post('/api/channels', { data: ch });
    if (r.ok()) {
      const b = (await r.json()) as { id: number };
      seededChannelIds.push(b.id);
    }
  }
});

test.afterAll(async ({ request }) => {
  for (const s of seeded) {
    await deleteMonitorViaApi(request, s.type, s.id);
  }
  for (const id of seededChannelIds) {
    await request.delete(`/api/channels/${id}`).catch(() => {});
  }
});

// Not serial — addInitScript stamps localStorage per-page, so each
// test starts in its own theme. A failure in one shot must not abort
// the rest (e.g. heartbeat detail will fail until the worker is
// restarted to pick up the new hash route, but the other 4 surfaces
// don't need a restart).

for (const theme of THEMES) {
  test(`${theme} — dashboard list`, async ({ page }) => {
    await applyTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByTestId('monitors-tab-url').waitFor({ state: 'visible' });
    await shot(page, theme, 'dashboard');
  });

  test(`${theme} — add-monitor dialog (heartbeat tile selected)`, async ({ page }) => {
    await applyTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await page.getByTestId('header-add-monitor-btn').click();
    await page.getByTestId('add-monitor-dialog').waitFor({ state: 'visible' });
    // Select the heartbeat tile so the screenshot showcases the NEW
    // monitor type rather than the default URL form.
    await page.getByTestId('add-monitor-type-tile-heartbeat').click();
    // Wait for the heartbeat-specific row to swap in.
    await page.locator('#heartbeat-row').waitFor({ state: 'visible' });
    await shot(page, theme, 'add-monitor');
  });

  test(`${theme} — heartbeat detail`, async ({ page }) => {
    if (seededHeartbeatId === null) test.skip(true, 'no seeded heartbeat');
    await applyTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/#/heartbeat/${seededHeartbeatId}`);
    await page.getByTestId('heartbeat-ping-url').waitFor({ state: 'visible' });
    await shot(page, theme, 'heartbeat-detail');
  });

  test(`${theme} — regions`, async ({ page }) => {
    await applyTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/regions');
    await page.getByTestId('page-title').waitFor({ state: 'visible' });
    await shot(page, theme, 'regions');
  });

  test(`${theme} — channels`, async ({ page }) => {
    await applyTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/#/channels');
    await page.getByTestId('page-title').waitFor({ state: 'visible' });
    await shot(page, theme, 'channels');
  });
}
