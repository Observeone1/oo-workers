import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

// Phase 6.5 — run artifacts.
//
// Create a QA monitor with a deliberately-failing script, trigger a run,
// and confirm the detail page surfaces a trace download link + at least
// one screenshot thumbnail. Also exercises the /api/artifacts proxy by
// fetching the trace bytes through it.
//
// We can't easily wait on the queue under load, so we hit "Run now" via
// the API and poll the monitor detail endpoint until an execution row
// flips out of `running`. Up to 120s — Playwright cold-start plus a
// failing run with trace capture is the long pole.

const FAIL_SCRIPT = `import { test, expect } from '@playwright/test';

test('intentionally fails', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle('this title does not exist', { timeout: 3000 });
});
`;

test('failed QA run uploads trace + screenshot and detail page surfaces them', async ({
  page,
  request,
}) => {
  // Playwright cold-start + retain-on-failure trace capture + a possibly
  // saturated queue can push us well past the 30s default. Cap at 3
  // minutes for this single test.
  test.setTimeout(180_000);

  await page.goto('/');
  await waitForList(page);

  const name = `e2e-artifacts-${uniqueSuffix()}`;

  // Create via the dialog so we exercise the same path real users hit.
  await page.locator('#add-btn').click();
  await page.locator('#type-select').selectOption('qa');
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="url"]').fill('https://example.com');
  await page.locator('#add-form textarea[name="qa_script"]').fill(FAIL_SCRIPT);
  await page.locator('#add-form button[type="submit"]').click();
  await waitForList(page);

  await page.locator('.tab[data-tab="qa"]').click();
  const row = page.locator('tr[data-open][data-type="qa"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });

  // Find the monitor id via the API so we can trigger + poll directly.
  const list = await (await request.get('/api/monitors')).json();
  const created = list.qa.find((m: { name: string; id: number }) => m.name === name);
  expect(created).toBeTruthy();

  // Trigger a run.
  await request.post(`/api/monitors/qa/${created.id}/run`);

  // Poll detail for a settled execution belonging to our project. The
  // first run can be slow (Playwright cold-start + retain-on-failure
  // trace capture). The scheduler may also enqueue concurrent runs, so
  // we look for any settled row rather than assuming the latest is ours.
  type RunRow = {
    status: string;
    traceUrl?: string | null;
    screenshotUrls?: string[] | null;
  };
  let settled: RunRow | null = null;
  for (let i = 0; i < 60; i++) {
    const res = await request.get(`/api/monitors/qa/${created.id}`);
    const body = (await res.json()) as { runs: RunRow[] };
    const failed = body.runs.find(
      (r) => r.status === 'failed' || r.status === 'passed' || r.status === 'error',
    );
    if (failed) {
      settled = failed;
      break;
    }
    await page.waitForTimeout(2000);
  }
  expect(settled, 'execution did not settle in 120s').toBeTruthy();

  const latest = settled!;
  expect(latest.status, 'expected the deliberately-failing run to fail').toBe('failed');
  expect(latest.traceUrl, 'trace_url should be set').toBeTruthy();
  expect(
    Array.isArray(latest.screenshotUrls) && latest.screenshotUrls.length > 0,
    'screenshot_urls should have at least one key',
  ).toBe(true);

  // Visit detail page and assert the artifacts cell rendered.
  await page.goto(`/#/qa/${created.id}`);
  await page.waitForSelector('.detail-meta', { timeout: 10_000 });
  const traceLink = page.locator('a.artifact-link', { hasText: 'trace.zip' }).first();
  await expect(traceLink).toBeVisible();
  await expect(page.locator('a.artifact-thumb').first()).toBeVisible();

  // Fetch the trace through the proxy and confirm we get a non-empty zip.
  const traceRes = await request.get(`/api/artifacts?key=${encodeURIComponent(latest.traceUrl!)}`);
  if (!traceRes.ok()) {
    const body = await traceRes.text();
    throw new Error(`proxy returned ${traceRes.status()}: ${body.slice(0, 300)}`);
  }
  const bytes = await traceRes.body();
  expect(bytes.length).toBeGreaterThan(100);

  await deleteMonitorViaApi(request, 'qa', created.id);
});
