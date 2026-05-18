import { test, expect, waitForList, uniqueSuffix, ensureSessionAccount } from './fixtures';

// Guard: QA/browser checks run on the master only — binding one to a
// region just yields ERROR exec rows. The add dialog must hide the
// "Run from" picker (#regions-row) when type=qa. Needs at least one
// region to exist, else the row is hidden anyway and proves nothing.

const HAS_KEY = !!process.env.OO_E2E_API_KEY;

test('add dialog hides the region picker for qa, shows it otherwise', async ({
  page,
  request,
  baseURL,
  shot,
}) => {
  if (!HAS_KEY) {
    test.skip(
      !(await ensureSessionAccount(request)),
      'no usable auth — set OO_E2E_API_KEY or use a fresh stack',
    );
  }

  // Seed a region so #regions-row is eligible to show.
  const slug = `qg-${uniqueSuffix()}`;
  const res = await request.post(`${baseURL}/api/regions`, {
    data: { slug, label: `qa-guard ${slug}` },
  });
  expect(res.ok()).toBeTruthy();
  const regionId = (await res.json()).region.id as number;

  try {
    await page.goto('/');
    await waitForList(page);
    await page.locator('#add-btn').click();
    await expect(page.locator('#add-dialog')).toBeVisible();
    const row = page.locator('#regions-row');

    // Non-qa with a region present → picker visible.
    await page.locator('#type-select').selectOption('url');
    await expect(row).toBeVisible();

    // qa → guard hides it.
    await page.locator('#type-select').selectOption('qa');
    await expect(row).toBeHidden();
    await shot('qa_region_guard_hidden');

    // Toggling back restores it (the guard isn't sticky).
    await page.locator('#type-select').selectOption('url');
    await expect(row).toBeVisible();
  } finally {
    await request.delete(`${baseURL}/api/regions/${regionId}`).catch(() => {});
  }
});
