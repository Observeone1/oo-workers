import { gunzipSync, gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { test, expect, waitForList, uniqueSuffix, ensureSessionAccount } from './fixtures';

// Backup/restore UI coverage. The download + auth + schema-guard cases are
// NON-destructive (the guard and the auth check both reject before restore's
// TRUNCATE), so they're safe against the live dev stack. The full UI
// round-trip TRUNCATEs everything and is opt-in only — never the dev DB.

function manifestOf(src: string | Buffer): { format: number; schemaHead: string; scope: string } {
  const bytes = typeof src === 'string' ? readFileSync(src) : src;
  const text = gunzipSync(bytes).toString('utf8');
  return JSON.parse(text.split('\n')[0]).manifest;
}

// Auth like the rest of the suite: a config-level Bearer (OO_E2E_API_KEY)
// covers both the page and `request`; otherwise fall back to a cookie
// session, and skip visibly if neither is usable (polluted stack).
const HAS_KEY = !!process.env.OO_E2E_API_KEY;
test.beforeEach(async ({ request }) => {
  if (HAS_KEY) return;
  test.skip(
    !(await ensureSessionAccount(request)),
    'no usable auth — set OO_E2E_API_KEY or run against a fresh stack',
  );
});

// Per-scope row-inclusion correctness (window vs all) is covered
// deterministically against small isolated DBs by
// scripts/backup-restore-test.ts. These UI/stack tests run against
// whatever (possibly huge) instance the operator points at, so they use
// scope=none — a tiny, constant dump — to assert the contract only.

test('clicking Download produces a real dump file', async ({ page, shot }) => {
  // v2: backup moved from a header dialog (#backup-btn → #backup-dialog)
  // into the Settings → Backup tab. Scope picker became a segmented
  // control (data-val=none|window|all) instead of radio inputs.
  await page.goto('/#/settings');
  await page.getByTestId('settings-tab-backup').click();
  await expect(page.getByTestId('backup-download-btn')).toBeVisible();
  await page.getByTestId('backup-scope-none').click();
  await shot('backup_dialog');

  const dl = page.waitForEvent('download');
  await page.getByTestId('backup-download-btn').click();
  const download = await dl;

  const m = manifestOf(await download.path());
  expect(m.format).toBe(1);
  expect(m.schemaHead.length).toBeGreaterThan(0);
  expect(m.scope).toBe('none');
  await shot('backup_downloaded');
});

test('GET /api/backup serves a correctly-named, well-formed dump', async ({ request, baseURL }) => {
  // Server-contract check — bundle-independent (a stale dev ui-server
  // can't mask it), and the authoritative filename regression guard.
  const res = await request.get(`${baseURL}/api/backup?scope=none`);
  expect(res.ok()).toBeTruthy();
  expect(res.headers()['content-disposition']).toMatch(/filename="oo-backup-.*\.oodump\.gz"/);
  const m = manifestOf(Buffer.from(await res.body()));
  expect(m.format).toBe(1);
  expect(m.schemaHead.length).toBeGreaterThan(0);
  expect(m.scope).toBe('none');
});

test('backup + restore endpoints reject unauthenticated callers', async ({ browser, baseURL }) => {
  // Explicitly clear config-level headers (the Bearer is applied to
  // manually-created contexts too) so this is genuinely unauthenticated.
  const anon = await browser.newContext({ extraHTTPHeaders: {} });
  try {
    const g = await anon.request.get(`${baseURL}/api/backup`);
    expect(g.status()).toBe(401);
    const p = await anon.request.post(`${baseURL}/api/restore`, {
      headers: { 'content-type': 'application/gzip' },
      data: Buffer.from([0x1f, 0x8b]),
    });
    expect(p.status()).toBe(401);
  } finally {
    await anon.close();
  }
});

test('schema-head guard rejects before truncate (live DB untouched)', async ({ request, baseURL }) => {
  // Smallest authed dump, then tamper its manifest head.
  const res = await request.get(`${baseURL}/api/backup?scope=none`);
  expect(res.ok()).toBeTruthy();
  const text = gunzipSync(Buffer.from(await res.body())).toString('utf8');
  const lines = text.split('\n');
  const m0 = JSON.parse(lines[0]);
  m0.manifest.schemaHead = '9999_tampered.sql';
  lines[0] = JSON.stringify(m0);
  const tampered = gzipSync(Buffer.from(lines.join('\n')));

  const before = await (await request.get(`${baseURL}/api/monitors`)).json();
  const restore = await request.post(`${baseURL}/api/restore?force=1`, {
    headers: { 'content-type': 'application/gzip' },
    data: tampered,
  });
  expect(restore.status()).toBe(400);
  expect(JSON.stringify(await restore.json())).toMatch(/schema mismatch/i);

  // The guard fires pre-TRUNCATE, so the live stack must be unchanged.
  const after = await (await request.get(`${baseURL}/api/monitors`)).json();
  const count = (x: Record<string, unknown[]>) =>
    Object.values(x).reduce((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
  expect(count(after)).toBe(count(before));
});

// Full UI round-trip TRUNCATEs the target. Opt-in only, against a
// throwaway stack — never the dev DB. Visible skip, like the other specs.
test('full restore round-trip through the dashboard', async ({ page, request, baseURL, shot }) => {
  test.skip(
    process.env.OO_E2E_RESTORE_DESTRUCTIVE !== '1',
    'destructive (wipes the target) — set OO_E2E_RESTORE_DESTRUCTIVE=1 against a disposable stack',
  );

  const name = `e2e-backup-${uniqueSuffix()}`;
  const created = await request.post(`${baseURL}/api/monitors/url`, {
    data: { name, url: 'https://example.com', intervalSeconds: 60, timeoutMs: 5000 },
  });
  const { id } = (await created.json()) as { id: number };

  await page.goto('/');
  await waitForList(page);
  await page.locator('#backup-btn').click();
  const dl = page.waitForEvent('download');
  await page.locator('#backup-dialog input[name="backup_scope"][value="all"]').check();
  await page.locator('#backup-download').click();
  const backup = await (await dl).path();

  // Drop the monitor so the restore visibly brings it back.
  await request.delete(`${baseURL}/api/monitors/url/${id}`);

  await page.locator('#backup-file').setInputFiles(backup);
  await page.locator('#backup-restore').click();
  await expect(page.locator('#confirm-dialog')).toBeVisible();
  await shot('restore_confirm');
  await page.locator('#confirm-dialog .confirm-ok').click();
  await expect(page.locator('#alert-dialog')).toContainText(/restored/i, { timeout: 30_000 });
  await shot('restore_done');

  const list = (await (await request.get(`${baseURL}/api/monitors`)).json()) as {
    url: { name: string }[];
  };
  expect(list.url.some((m) => m.name === name)).toBeTruthy();
});
