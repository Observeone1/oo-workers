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
