import { test as base, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SHOT_DIR = join(import.meta.dirname, 'screenshots');

export const test = base.extend<{
  shot: (name: string, page?: Page) => Promise<void>;
}>({
  shot: async ({ page: fixturePage }, use, testInfo) => {
    await use(async (name: string, override?: Page) => {
      const target = override ?? fixturePage;
      const safe = `${testInfo.title.replace(/[^\w-]+/g, '_')}__${name}.png`;
      const path = join(SHOT_DIR, safe);
      mkdirSync(dirname(path), { recursive: true });
      await target.screenshot({ path, fullPage: true });
    });
  },
});

export { expect };

// Wait for the list view to be ready (tabs rendered).
export async function waitForList(page: Page) {
  await page.waitForSelector('.tab[data-tab="url"]');
}

// Unique suffix for monitor names so reruns don't clash with leftover rows.
export const uniqueSuffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// Best-effort cleanup hitting the API directly. Tests should still drive
// delete via the UI for coverage, but this is a safety net.
export async function deleteMonitorViaApi(
  request: import('@playwright/test').APIRequestContext,
  type: 'url' | 'api' | 'qa' | 'tcp' | 'udp',
  id: number,
) {
  await request.delete(`/api/monitors/${type}/${id}`).catch(() => {});
}
