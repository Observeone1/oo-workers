/**
 * Browser-layer assertions for the multi-region harness. Run by run.sh AFTER it
 * has stood up a real agent container and confirmed (at the data layer) that the
 * region is online and a regional execution was recorded. These specs prove the
 * dashboard surfaces that regional agent to an operator.
 *
 * Env passed in by run.sh: OO_E2E_API_KEY (auth, via config), OO_E2E_REGION_SLUG,
 * OO_E2E_MON_ID.
 */
import { test, expect } from '../ui/fixtures';

const SLUG = process.env.OO_E2E_REGION_SLUG ?? 'e2e-mr';
const MON_ID = process.env.OO_E2E_MON_ID ?? '';

test('[9] regions page shows the agent region online', async ({ page }) => {
  await page.goto('/#/regions');
  const card = page.getByTestId(`region-card-${SLUG}`);
  await expect(card).toBeVisible({ timeout: 10_000 });
  await expect(card).toContainText('online');
  await expect(card).not.toHaveClass(/offline/);
});

test('[9] navbar region badge reports at least one online', async ({ page }) => {
  await page.goto('/');
  const badge = page.locator('#regions-badge');
  await expect(badge).toBeVisible({ timeout: 10_000 });
  await expect(badge).toHaveClass(/has-online/);
});

test('[10] monitor detail surfaces the regional run', async ({ page }) => {
  test.skip(!MON_ID, 'OO_E2E_MON_ID not provided');
  await page.goto(`/#/url/${MON_ID}`);
  // A regional execution produces a per-region chip/label on the detail view.
  // Accept either the region label ("MR E2E") or its slug.
  await expect(page.getByText(new RegExp(`MR E2E|${SLUG}`)).first()).toBeVisible({
    timeout: 10_000,
  });
});
