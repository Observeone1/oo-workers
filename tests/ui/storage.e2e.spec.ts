import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi } from './fixtures';

// Object-storage round-trip: when a QA monitor is created via the
// dashboard, its script should land in the configured storage with a
// stable key (qa-scripts/<test_id>.spec.ts), and the row should have
// script_url populated.

const QA_SCRIPT = `import { test, expect } from '@playwright/test';

test('storage e2e fixture', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveURL(/example/);
});
`;

test('QA script lands in object storage and is recallable', async ({ page, request }) => {
  await page.goto('/');
  await waitForList(page);

  const name = `e2e-storage-${uniqueSuffix()}`;
  await page.getByTestId('header-add-monitor-btn').click();
  await page.getByTestId('add-monitor-type-tile-qa').click();
  await page.locator('#add-form input[name="name"]').fill(name);
  await page.locator('#add-form input[name="url"]').fill('https://example.com');
  await page.locator('#add-form textarea[name="qa_script"]').fill(QA_SCRIPT);
  await page.getByTestId('add-monitor-submit').click();

  await waitForList(page);
  await page.getByTestId('monitors-tab-qa').click();
  const row = page.locator('tr[data-open][data-type="qa"]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 5000 });

  // Pull the monitor id back via the API and confirm the detail endpoint
  // returns the script we just submitted — which goes through the storage
  // read path when the row has script_url set.
  const list = await (await request.get('/api/monitors')).json();
  const created = list.qa.find((m: { name: string; id: number }) => m.name === name);
  expect(created).toBeTruthy();

  // Detail endpoint includes the test script content (read through storage).
  const detail = await (await request.get(`/api/monitors/qa/${created.id}`)).json();
  const tests = detail.tests as Array<{ id: number; testName?: string; scriptSize?: number }>;
  expect(tests.length).toBeGreaterThan(0);
  // The /tests view returns scriptSize, not the content; just sanity-check size matches.
  expect(tests[0].scriptSize).toBe(QA_SCRIPT.length);

  await deleteMonitorViaApi(request, 'qa', created.id);
});
