import {
  test,
  expect,
  waitForList,
  uniqueSuffix,
  deleteMonitorViaApi,
} from './fixtures';

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

test('search filters list by name (case-insensitive substring)', async ({
  page,
  request,
  shot,
}) => {
  const suffix = uniqueSuffix();
  const a = await seedUrl(request, `e2e-search-alpha-${suffix}`);
  const b = await seedUrl(request, `e2e-search-beta-${suffix}`);
  const c = await seedUrl(request, `e2e-search-gamma-${suffix}`);

  await page.goto('/');
  await waitForList(page);
  const search = page.getByTestId('monitors-search-input');
  await expect(search).toBeVisible();

  await search.fill(`alpha-${suffix}`);

  const matchedRow = page.locator('tr[data-open]', { hasText: `e2e-search-alpha-${suffix}` });
  await expect(matchedRow).toHaveCount(1);
  await expect(
    page.locator('tr[data-open]', { hasText: `e2e-search-beta-${suffix}` }),
  ).toHaveCount(0);
  // v2 summary text format is "N–M of K (filtered from L)" — "filtered from"
  // is the stable marker that the filter is active.
  await expect(page.getByTestId('monitors-summary')).toContainText('filtered from');
  await shot('search_alpha_match');

  // Case-insensitive
  await search.fill(`BETA-${suffix}`);
  await expect(
    page.locator('tr[data-open]', { hasText: `e2e-search-beta-${suffix}` }),
  ).toHaveCount(1);

  await Promise.all([a, b, c].map((m) => deleteMonitorViaApi(request, 'url', m.id)));
});

test('no-match search shows empty state with a clear link', async ({ page, request, shot }) => {
  const suffix = uniqueSuffix();
  const a = await seedUrl(request, `e2e-search-x-${suffix}`);

  await page.goto('/');
  await waitForList(page);
  await page.getByTestId('monitors-search-input').fill(`zzz-no-such-monitor-${suffix}`);

  await expect(page.getByTestId('list-empty')).toContainText('No URL monitors match');
  await expect(page.getByTestId('search-clear-link')).toBeVisible();
  await shot('search_no_match');

  await page.getByTestId('search-clear-link').click();
  await expect(page.getByTestId('monitors-search-input')).toHaveValue('');
  // After clearing, the rows are back (at least the one we seeded).
  await expect(
    page.locator('tr[data-open]', { hasText: `e2e-search-x-${suffix}` }),
  ).toHaveCount(1);

  await deleteMonitorViaApi(request, 'url', a.id);
});
