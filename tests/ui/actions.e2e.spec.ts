import {
  test,
  expect,
  waitForList,
  uniqueSuffix,
  deleteMonitorViaApi,
} from './fixtures';

// Helper: create a fresh URL monitor via the API so each action test owns its row.
async function seedUrl(request: import('@playwright/test').APIRequestContext, name: string) {
  const res = await request.post('/api/monitors/url', {
    data: {
      name,
      url: 'https://example.com',
      intervalSeconds: 60,
      timeoutMs: 10_000,
      assertions: [{ operator: 'equals', statusCode: 200 }],
    },
  });
  expect(res.ok()).toBe(true);
  return (await res.json()) as { id: number; name: string };
}

test('Run now from row triggers a fresh execution', async ({ page, request, shot }) => {
  const seed = await seedUrl(request, `e2e-run-${uniqueSuffix()}`);

  await page.goto('/');
  await waitForList(page);
  const row = page.locator(`tr[data-open][data-type="url"][data-id="${seed.id}"]`);
  await row.waitFor();
  await row.locator('button[data-run]').click();

  // The execution should land within ~5s on the live worker.
  await expect
    .poll(
      async () => {
        const d = await (await request.get(`/api/monitors/url/${seed.id}`)).json();
        return d.runs?.[0]?.status ?? null;
      },
      { timeout: 10_000, intervals: [500, 750, 1000] },
    )
    .toMatch(/SUCCESS|FAILED/);

  await shot('after_run_now');
  await deleteMonitorViaApi(request, 'url', seed.id);
});

test('Pause/Resume toggle flips enabled state and row opacity', async ({ page, request, shot }) => {
  const seed = await seedUrl(request, `e2e-toggle-${uniqueSuffix()}`);

  await page.goto('/');
  await waitForList(page);
  const row = page.locator(`tr[data-open][data-type="url"][data-id="${seed.id}"]`);
  await row.waitFor();
  await expect(row).not.toHaveClass(/disabled/);

  await row.locator('button[data-toggle]').click();
  await expect(row).toHaveClass(/disabled/);
  // v2 replaced the "Pause"/"Resume" button text with an icon; state
  // lives in title and data-enabled attrs (data-enabled is the
  // stricter machine-readable contract).
  await expect(row.locator('button[data-toggle]')).toHaveAttribute('data-enabled', 'false');
  await expect(row.locator('button[data-toggle]')).toHaveAttribute('title', 'Resume');
  await shot('row_paused');

  await row.locator('button[data-toggle]').click();
  await expect(row).not.toHaveClass(/disabled/);
  await expect(row.locator('button[data-toggle]')).toHaveAttribute('data-enabled', 'true');
  await expect(row.locator('button[data-toggle]')).toHaveAttribute('title', 'Pause');

  await deleteMonitorViaApi(request, 'url', seed.id);
});

test('Delete removes the row (confirms via native dialog)', async ({ page, request, shot }) => {
  const seed = await seedUrl(request, `e2e-delete-${uniqueSuffix()}`);

  await page.goto('/');
  await waitForList(page);
  const row = page.locator(`tr[data-open][data-type="url"][data-id="${seed.id}"]`);
  await row.waitFor();

  await row.locator('button[data-del]').click();
  // Click the Confirm button in the native <dialog>
  await page.locator('#confirm-dialog .confirm-ok').click();
  await expect(row).toHaveCount(0, { timeout: 5000 });
  await shot('row_deleted');

  // Verify via API that nothing remains.
  const list = await (await request.get('/api/monitors')).json();
  expect(list.url.find((m: { id: number }) => m.id === seed.id)).toBeUndefined();
});
