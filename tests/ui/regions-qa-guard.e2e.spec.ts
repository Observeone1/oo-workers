import { test, expect, waitForList, uniqueSuffix, ensureSessionAccount } from './fixtures';

// Previously this spec asserted the OPPOSITE: that QA hid the region picker
// because browser checks were master-only. PRs #74/#75 enable QA-on-agents,
// so the picker now stays visible for type=qa — operators can opt into
// running browser checks from any region whose agent has Playwright.
// Heartbeat still hides the row (no probe direction).

const HAS_KEY = !!process.env.OO_E2E_API_KEY;

test('add dialog shows the region picker for qa now that agents support it', async ({
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
    await page.getByTestId('header-add-monitor-btn').click();
    await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
    const row = page.getByTestId('add-monitor-regions-row');

    // Non-qa with a region present → picker visible.
    await page.getByTestId('add-monitor-type-tile-url').click();
    await expect(row).toBeVisible();

    // qa → picker STAYS visible (was hidden pre-PR #74/#75).
    await page.getByTestId('add-monitor-type-tile-qa').click();
    await expect(row).toBeVisible();
    await shot('qa_region_picker_now_visible');

    // Heartbeat still hides it (no probe direction).
    await page.getByTestId('add-monitor-type-tile-heartbeat').click();
    await expect(row).toBeHidden();
  } finally {
    await request.delete(`${baseURL}/api/regions/${regionId}`).catch(() => {});
  }
});
