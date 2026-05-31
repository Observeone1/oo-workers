/**
 * End-to-end SSE smoke: the dashboard updates live without polling.
 *
 * Validates the full processor → exec-events bus → SSE endpoint →
 * EventSource → DOM patch chain. The wire-layer integration tests
 * (tests/integration/sse-*.spec.ts) cover the bus + endpoint in
 * isolation; this spec proves the browser actually receives + acts on
 * the events.
 *
 * Two scenarios:
 *
 *   1. Create-in-other-tab. Tab A is on the URL monitors list. The
 *      test request context (acts as "tab B") creates a new URL
 *      monitor via the API. The new row must appear in tab A's list
 *      within ~2s (NOT waiting for the old 5s poll, which is deleted).
 *
 *   2. Delete-from-other-tab. Tab A is on a monitor detail page.
 *      The test request context deletes that monitor. Tab A must
 *      bounce back to the list (detail.ts's monitor-deleted handler).
 *
 * The 2s upper bound is intentionally tight — the old polling
 * baseline was 5s. If a future regression resets the listener
 * wiring or breaks SSE, this spec fails on the 5s polling path too.
 */

import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

test('list view updates live when a monitor is created in another context', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await waitForList(page);
  await page.getByTestId('monitors-tab-url').click();

  const name = `e2e-sse-create-${uniqueSuffix()}`;

  // "Tab B" creates a monitor via the API while page is on the URL list.
  const createRes = await request.post('/api/monitors/url', {
    data: {
      name,
      url: 'https://example.com',
      intervalSeconds: 60,
      timeoutMs: 10_000,
      assertions: [{ operator: 'equals', statusCode: 200 }],
    },
  });
  const created = (await createRes.json()) as { id: number };

  // The row should show up in the list without us reloading the page.
  // 2s gives the SSE event a generous trip + the renderList() call.
  // If polling were the mechanism, this would fail (old poll was 5s).
  await expect(
    page.locator('tr[data-open][data-type="url"]', { hasText: name }),
  ).toBeVisible({ timeout: 2_500 });

  await deleteMonitorViaApi(request, 'url', created.id);
});

test('detail view bounces to list when the monitor is deleted elsewhere', async ({
  page,
  request,
}) => {
  // Seed a monitor + navigate page to its detail.
  const name = `e2e-sse-delete-${uniqueSuffix()}`;
  const createRes = await request.post('/api/monitors/url', {
    data: {
      name,
      url: 'https://example.com',
      intervalSeconds: 60,
      timeoutMs: 10_000,
      assertions: [{ operator: 'equals', statusCode: 200 }],
    },
  });
  const created = (await createRes.json()) as { id: number };

  await page.goto(`/#/url/${created.id}`);
  await expect(page.getByTestId('detail-meta-cards')).toBeVisible({ timeout: 5_000 });

  // Delete via the API context.
  await deleteMonitorViaApi(request, 'url', created.id);

  // Detail page must bounce to the list. detail.ts's monitor-deleted
  // handler sets location.hash to '#/' on a matching event.
  await expect.poll(() => page.evaluate(() => location.hash), { timeout: 2_500 }).toBe('#/');
});

// Heartbeat OVERDUE-flip e2e.
//
// This is the ONLY spec in the suite that asserts a *scheduler-originated*
// event (the worker's tickHeartbeats OVERDUE sweep) reaching the *browser*.
// Every other SSE spec asserts create/delete, which fire in the ui process
// and reach the SSE stream trivially. Because the e2e runs against the real
// two-process stack (baseURL = the docker `ui` container; the worker is a
// separate process), this spec exercises the worker → Redis → ui → browser
// path end to end.
//
// It was wrongly skipped in v1.27.1 with a "headless throttling" excuse. The
// real cause was a shipped bug: the event bus was an in-process EventEmitter,
// so the OVERDUE event emitted in the worker never crossed to the ui process
// and never reached the DOM. The skip hid a true failure. Fixed in v1.28.1
// by bridging the bus over Redis pub/sub (see
// tests/integration/exec-events-bridge.it.spec.ts for the fast layer); this
// spec is the end-to-end guard that it stays fixed in the deployed topology.
test('heartbeat status flips UP → OVERDUE → UP live as pings arrive', async ({
  page,
  request,
}) => {
  // The OVERDUE flip needs period (30s, the tightest the validators
  // accept) + up to one scheduler sweep (5s), then a recovery ping +
  // round-trip. That is well past Playwright's default 30s per-test
  // budget — which is what actually doomed this spec before (the test
  // timed out ~4s BEFORE the heartbeat even went OVERDUE, never giving
  // the 90s assertion a chance). Give it real headroom.
  test.setTimeout(150_000);

  // Period 30s + grace 0s is the tightest the API accepts
  // (validators reject periodSeconds < 30). The sweep only OVERDUEs
  // heartbeats already in UP state, so we ping first to get there.
  const name = `e2e-sse-hb-${uniqueSuffix()}`;
  const createRes = await request.post('/api/monitors/heartbeat', {
    data: { name, periodSeconds: 30, graceSeconds: 0 },
  });
  const created = (await createRes.json()) as { id: number; token: string };

  // Prime to UP via a first ping.
  await request.post(`/heartbeat/${created.token}`);

  await page.goto(`/#/heartbeat/${created.id}`);
  await expect(page.getByTestId('detail-meta-cards')).toBeVisible({ timeout: 5_000 });

  const statusCell = page
    .getByTestId('detail-meta-cards')
    .locator('.meta-card')
    .first()
    .locator('.val');

  // Wait for UP → OVERDUE. 30s + sweep cadence (5s) = ~35s in theory,
  // but the worker's scheduler tick can drift in dev, and the SSE
  // event has to round-trip to the browser. 90s gives headroom for
  // headless throttling without hiding real regressions.
  await expect(statusCell).toContainText('OVERDUE', { timeout: 90_000 });

  // Ping again. The detail page's monitor-state subscriber re-renders
  // and the status pill flips back to UP within ~2s (SSE round-trip).
  const recoveryRes = await request.post(`/heartbeat/${created.token}`);
  expect(recoveryRes.status()).toBe(200);
  await expect(statusCell).toContainText('UP', { timeout: 2_500 });

  await deleteMonitorViaApi(request, 'heartbeat', created.id);
});

test('list view updates live when a monitor is deleted elsewhere', async ({ page, request }) => {
  // Seed + verify the row is visible in the list.
  const name = `e2e-sse-list-delete-${uniqueSuffix()}`;
  const createRes = await request.post('/api/monitors/url', {
    data: {
      name,
      url: 'https://example.com',
      intervalSeconds: 60,
      timeoutMs: 10_000,
      assertions: [{ operator: 'equals', statusCode: 200 }],
    },
  });
  const created = (await createRes.json()) as { id: number };

  await page.goto('/');
  await waitForList(page);
  await page.getByTestId('monitors-tab-url').click();
  const row = page.locator('tr[data-open][data-type="url"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5_000 });

  await deleteMonitorViaApi(request, 'url', created.id);

  // Row should disappear without a manual refresh.
  await expect(row).toBeHidden({ timeout: 2_500 });
});

// The list view must reflect a *check run* live — status + latency, not just
// create/delete. This is the regression that shipped from v1.26.0: the poll
// that drove status/latency was removed but the execution-event wiring was
// never added, so the list went stale until you clicked into a monitor or
// hit run. No spec asserted it, which is why it shipped silent. Fixed v1.28.2.
test('list view updates a row live when its check runs', async ({ page, request }) => {
  const name = `e2e-sse-list-exec-${uniqueSuffix()}`;
  const createRes = await request.post('/api/monitors/url', {
    data: {
      name,
      url: 'https://example.com',
      intervalSeconds: 300, // long, so only the forced run drives the update
      timeoutMs: 10_000,
      assertions: [{ operator: 'equals', statusCode: 200 }],
    },
  });
  const created = (await createRes.json()) as { id: number };

  await page.goto('/');
  await waitForList(page);
  await page.getByTestId('monitors-tab-url').click();
  const row = page.locator('tr[data-open][data-type="url"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5_000 });

  // Fresh monitor: no run yet, so the latency cell shows the "—" placeholder.
  const latency = row.locator('.cell-num');
  await expect(latency).toHaveText('—');

  // Force a run. The execution event must update the row's latency live —
  // no reload, no navigation. Before the fix the list ignored execution
  // events entirely and this cell stayed "—".
  await request.post(`/api/monitors/url/${created.id}/run`);
  await expect(latency).toContainText('ms', { timeout: 10_000 });

  await deleteMonitorViaApi(request, 'url', created.id);
});
