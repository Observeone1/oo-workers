import { test as base, expect, type Page, type APIRequestContext } from '@playwright/test';
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
// Anchored on data-testid per tests/ui/CONVENTIONS.md.
export async function waitForList(page: Page) {
  await page.getByTestId('monitors-tab-url').waitFor({ state: 'visible' });
}

// Unique suffix for monitor names so reruns don't clash with leftover rows.
export const uniqueSuffix = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// Known email/password account the cookie-session specs sign in with.
// Overridable so the same specs can run against an operator's existing
// stack; defaults make a fresh stack self-provision.
export const E2E_USER = {
  email: process.env.OO_E2E_USER_EMAIL ?? 'e2e-session@example.com',
  password: process.env.OO_E2E_USER_PASSWORD ?? 'e2e-session-pw-123456',
  name: 'E2E Session User',
};

// Make sure E2E_USER exists on the stack. On a fresh stack this creates the
// first admin via the setup wizard. Returns true if the credentials work;
// false if the stack already has a *different* admin (we can't provision
// over it — callers should test.skip).
export async function ensureSessionAccount(request: APIRequestContext): Promise<boolean> {
  const statusRes = await request.get('/api/auth/setup-status');
  if (statusRes.ok()) {
    const { needsSetup } = (await statusRes.json()) as { needsSetup: boolean };
    if (needsSetup) {
      await request.post('/api/auth/setup', { data: E2E_USER });
    }
  }
  const loginRes = await request.post('/api/auth/login', {
    data: { email: E2E_USER.email, password: E2E_USER.password },
  });
  if (!loginRes.ok()) {
    // Make a polluted-stack skip visible — otherwise auth coverage goes
    // dark silently and a green run looks like a pass.
    console.warn(
      `[e2e] cookie-session specs SKIPPED: ${E2E_USER.email} cannot log in ` +
        `(stack already has a different admin). Use a fresh DB or set ` +
        `OO_E2E_USER_EMAIL/OO_E2E_USER_PASSWORD.`,
    );
  }
  return loginRes.ok();
}

// Best-effort cleanup hitting the API directly. Tests should still drive
// delete via the UI for coverage, but this is a safety net.
export async function deleteMonitorViaApi(
  request: import('@playwright/test').APIRequestContext,
  type: 'url' | 'api' | 'qa' | 'tcp' | 'udp' | 'heartbeat',
  id: number,
) {
  await request.delete(`/api/monitors/${type}/${id}`).catch(() => {});
}

// Fetch a created monitor back through the single-GET endpoint so a spec can
// assert what the form actually serialized (interval, timeout, ...).
export async function fetchMonitor(
  request: APIRequestContext,
  type: 'url' | 'tcp',
  id: number,
): Promise<{ intervalSeconds: number; timeoutMs: number }> {
  const res = await request.get(`/api/monitors/${type}/${id}`);
  expect(res.ok(), `GET /api/monitors/${type}/${id} failed: ${res.status()}`).toBe(true);
  const body = (await res.json()) as { monitor: { intervalSeconds: number; timeoutMs: number } };
  return body.monitor;
}

// Resolve a dialog-created monitor's id by the unique name the spec typed.
export async function findCreatedId(
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

// Open the add-monitor dialog on the given type tile.
export async function openAddDialog(page: Page, tile: 'url' | 'tcp'): Promise<void> {
  await page.goto('/');
  await waitForList(page);
  await page.getByTestId('header-add-monitor-btn').click();
  await expect(page.getByTestId('add-monitor-dialog')).toBeVisible();
  await page.getByTestId(`add-monitor-type-tile-${tile}`).click();
}

// Seed a URL monitor for specs that need at least one row in the list
// (e.g. the detail view spec, or the status-page binding spec). The
// global-setup purge starts every run with an empty DB, so any spec
// that asserts on an existing row must create its own seed first.
// Returns { id, name } so the caller can clean up in afterAll.
export async function seedUrlMonitor(
  request: import('@playwright/test').APIRequestContext,
  opts: { url?: string; intervalSeconds?: number } = {},
): Promise<{ id: number; name: string }> {
  const name = `e2e-seed-${uniqueSuffix()}`;
  const res = await request.post('/api/monitors/url', {
    data: {
      name,
      url: opts.url ?? 'https://example.com',
      intervalSeconds: opts.intervalSeconds ?? 60,
      timeoutMs: 10_000,
      assertions: [{ operator: 'equals', statusCode: 200 }],
    },
  });
  if (!res.ok()) {
    throw new Error(`seedUrlMonitor failed: ${res.status()} ${await res.text()}`);
  }
  const created = (await res.json()) as { id: number };
  return { id: created.id, name };
}
