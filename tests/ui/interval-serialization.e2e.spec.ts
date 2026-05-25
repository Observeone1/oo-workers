/**
 * Repro test for the "typed 30 s, saved as 25 s" interval bug from the
 * 2026-05-24/25 manual e2e walk.
 *
 * The HTML input is prefilled with value="60", so how the operator clears
 * before typing matters. Each scenario exercises a different real-user path
 * (fill / overtype / arrow-step / paste). On submit, the test fetches the
 * created monitor and asserts intervalSeconds matches what was entered.
 *
 * If every scenario passes, the bug does not reproduce on current code and
 * should be closed as "needs live repro" with this spec as evidence.
 * If any scenario fails, the failing path identifies the root cause.
 */

import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';
import type { Page, APIRequestContext } from '@playwright/test';

async function fetchInterval(
  request: APIRequestContext,
  type: 'url' | 'tcp',
  id: number,
): Promise<number> {
  const res = await request.get(`/api/monitors/${type}/${id}`);
  expect(res.ok(), `GET /api/monitors/${type}/${id} failed: ${res.status()}`).toBe(true);
  const body = (await res.json()) as { monitor: { intervalSeconds: number } };
  return body.monitor.intervalSeconds;
}

async function findCreatedId(
  request: APIRequestContext,
  type: 'url' | 'tcp',
  name: string,
): Promise<number> {
  const list = (await (await request.get('/api/monitors')).json()) as Record<
    string,
    Array<{ id: number; name: string }>
  >;
  const row = list[type].find((m) => m.name === name);
  expect(row, `monitor '${name}' not found in /api/monitors[${type}]`).toBeDefined();
  return row!.id;
}

async function openAddDialog(page: Page, tile: 'url' | 'tcp'): Promise<void> {
  await page.goto('/');
  await waitForList(page);
  await page.getByTestId('header-add-monitor-btn').click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  await page.getByTestId(`add-monitor-type-tile-${tile}`).click();
}

test('A. URL interval — fill("30") (select-all + type, the canonical path)', async ({
  page,
  request,
}) => {
  await openAddDialog(page, 'url');
  const name = `e2e-interval-fill-${uniqueSuffix()}`;
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="url"]').fill('https://example.com');
  await page.locator('#add-form input[name="interval_seconds"]').fill('30');
  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  const id = await findCreatedId(request, 'url', name);
  try {
    expect(await fetchInterval(request, 'url', id)).toBe(30);
  } finally {
    await deleteMonitorViaApi(request, 'url', id);
  }
});

test('B. URL interval — focus + pressSequentially("30") without clearing (naive overtype)', async ({
  page,
  request,
}) => {
  await openAddDialog(page, 'url');
  const name = `e2e-interval-overtype-${uniqueSuffix()}`;
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="url"]').fill('https://example.com');

  // Click into the prefilled field (default "60") and type without clearing.
  // This is the real-user path the manual tester most likely took.
  const interval = page.locator('#add-form input[name="interval_seconds"]');
  await interval.click();
  await interval.pressSequentially('30');

  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  const id = await findCreatedId(request, 'url', name);
  try {
    const saved = await fetchInterval(request, 'url', id);
    // We assert what we typed (30). Whatever the form actually serialised is
    // the bug surface — record the actual on failure so the diagnosis is in
    // the test output.
    expect(saved, `typed "30" naively into prefilled "60"; saved ${saved}`).toBe(30);
  } finally {
    await deleteMonitorViaApi(request, 'url', id);
  }
});

test('C. URL interval — ArrowDown steps from 60 to 30', async ({ page, request }) => {
  await openAddDialog(page, 'url');
  const name = `e2e-interval-arrow-${uniqueSuffix()}`;
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="url"]').fill('https://example.com');

  // No `step` attribute on the input → default step is 1. 30 down-presses
  // should take 60 → 30. If a hidden step exists, fewer presses land elsewhere.
  const interval = page.locator('#add-form input[name="interval_seconds"]');
  await interval.focus();
  for (let i = 0; i < 30; i++) await interval.press('ArrowDown');

  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  const id = await findCreatedId(request, 'url', name);
  try {
    const saved = await fetchInterval(request, 'url', id);
    expect(saved, `ArrowDown x30 from 60; saved ${saved}`).toBe(30);
  } finally {
    await deleteMonitorViaApi(request, 'url', id);
  }
});

test('D. TCP interval — fill("30") (confirms it is not URL-specific)', async ({
  page,
  request,
}) => {
  await openAddDialog(page, 'tcp');
  const name = `e2e-interval-tcp-${uniqueSuffix()}`;
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="tcp_host"]').fill('example.com');
  await page.locator('#add-form input[name="tcp_port"]').fill('443');
  await page.locator('#add-form input[name="tcp_interval_seconds"]').fill('30');
  await page.getByTestId('add-monitor-submit').click();
  await waitForList(page);

  const id = await findCreatedId(request, 'tcp', name);
  try {
    expect(await fetchInterval(request, 'tcp', id)).toBe(30);
  } finally {
    await deleteMonitorViaApi(request, 'tcp', id);
  }
});
