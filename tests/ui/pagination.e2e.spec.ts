import {
  test,
  expect,
  waitForList,
  uniqueSuffix,
  deleteMonitorViaApi,
} from './fixtures';

const PAGE_SIZE = 20;

async function seedUrls(
  request: import('@playwright/test').APIRequestContext,
  prefix: string,
  count: number,
) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const res = await request.post('/api/monitors/url', {
      data: {
        name: `${prefix}-${String(i).padStart(2, '0')}`,
        url: 'https://example.com',
        intervalSeconds: 60,
        timeoutMs: 10_000,
        assertions: [{ operator: 'equals', statusCode: 200 }],
      },
    });
    expect(res.ok()).toBe(true);
    const j = (await res.json()) as { id: number };
    ids.push(j.id);
  }
  return ids;
}

test('pagination appears when filtered list > PAGE_SIZE, Prev/Next navigate pages', async ({
  page,
  request,
  shot,
}) => {
  const suffix = uniqueSuffix();
  const prefix = `e2e-page-${suffix}`;
  // Seed PAGE_SIZE + 5 so we get exactly 2 pages worth of *this* search.
  const ids = await seedUrls(request, prefix, PAGE_SIZE + 5);

  try {
    await page.goto('/');
    await waitForList(page);
    // Narrow with search so only our seeded rows show — independent of other test residue.
    await page.locator('#search-input').fill(prefix);

    const pagination = page.locator('.pagination');
    await expect(pagination).toBeVisible();
    await expect(pagination).toContainText('Page 1 of 2');
    await expect(page.locator('button[data-page-prev]')).toBeDisabled();
    await expect(page.locator('button[data-page-next]')).toBeEnabled();
    // Page 1 has exactly PAGE_SIZE rows.
    await expect(page.locator('tr[data-open]', { hasText: prefix })).toHaveCount(PAGE_SIZE);
    await shot('pagination_page_1');

    await page.locator('button[data-page-next]').click();
    await expect(pagination).toContainText('Page 2 of 2');
    await expect(page.locator('button[data-page-prev]')).toBeEnabled();
    await expect(page.locator('button[data-page-next]')).toBeDisabled();
    // Page 2 has the remaining 5.
    await expect(page.locator('tr[data-open]', { hasText: prefix })).toHaveCount(5);
    await shot('pagination_page_2');

    await page.locator('button[data-page-prev]').click();
    await expect(pagination).toContainText('Page 1 of 2');
  } finally {
    await Promise.all(ids.map((id) => deleteMonitorViaApi(request, 'url', id)));
  }
});
