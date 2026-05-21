import { gunzipSync, gzipSync, createGunzip } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import tar from 'tar-stream';
import { test, expect, uniqueSuffix, ensureSessionAccount } from './fixtures';

// Backup/restore UI coverage. Download + auth + schema-guard + dialog
// markup + format checks are NON-destructive and safe against the live dev
// stack. The destructive case (one — the full artifacts round-trip)
// TRUNCATES everything; runs by default on the configured stack since dev
// data is throwaway, and pre-flights the downloaded tar.gz before the wipe
// to refuse on an empty/auth-missing snapshot. OO_E2E_API_KEY is captured
// into a local snapshot so a mid-test crash can't lock the operator out.
//
// No separate DB-only restore case: every restore test must exercise the
// full path (DB + S3 artifacts together).

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
  // v1.8.0: the artifacts checkbox defaults to checked → tar.gz envelope.
  // This test asserts the *legacy* .oodump.gz path, so uncheck it first.
  await page.goto('/#/settings');
  await page.getByTestId('settings-tab-backup').click();
  await expect(page.getByTestId('backup-download-btn')).toBeVisible();
  await page.getByTestId('backup-include-artifacts').uncheck();
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

// ---------- v1.8.0 --include-artifacts dialog + format coverage ----------
// (The destructive UI restore is the artifacts round-trip below — there's
// no separate DB-only restore case. Per project convention: every restore
// test must exercise DB + S3 artifacts together.)

test('Backup dialog renders the include-artifacts checkbox + estimate', async ({ page, shot }) => {
  await page.goto('/#/settings');
  await page.getByTestId('settings-tab-backup').click();

  const cb = page.getByTestId('backup-include-artifacts');
  await expect(cb).toBeVisible();
  await expect(cb).toBeChecked(); // default: include

  // Estimate text element is always present; if the bucket has objects it
  // renders "(~N object…)", if empty the element stays blank. Either way
  // the element must exist next to the label.
  await expect(page.locator('#s-artifacts-estimate')).toBeAttached();
  await shot('include_artifacts_dialog');
});

test('GET /api/backup/estimate returns { artifactCount, artifactBytes }', async ({
  request,
  browser,
  baseURL,
}) => {
  const res = await request.get(`${baseURL}/api/backup/estimate`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { artifactCount: number; artifactBytes: number };
  expect(typeof body.artifactCount).toBe('number');
  expect(typeof body.artifactBytes).toBe('number');
  expect(body.artifactCount).toBeGreaterThanOrEqual(0);
  expect(body.artifactBytes).toBeGreaterThanOrEqual(0);

  // 401 unauthed (mirrors the existing /api/backup auth check).
  const anon = await browser.newContext({ extraHTTPHeaders: {} });
  try {
    const g = await anon.request.get(`${baseURL}/api/backup/estimate`);
    expect(g.status()).toBe(401);
  } finally {
    await anon.close();
  }
});

test('Download with checkbox ON → .oodump.tar.gz envelope', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByTestId('settings-tab-backup').click();
  await expect(page.getByTestId('backup-include-artifacts')).toBeChecked();
  await page.getByTestId('backup-scope-none').click(); // tiny dump

  const dl = page.waitForEvent('download');
  await page.getByTestId('backup-download-btn').click();
  const download = await dl;
  expect(download.suggestedFilename()).toMatch(/\.oodump\.tar\.gz$/);

  const path = await download.path();
  const buf = readFileSync(path);
  // gzip magic
  expect(buf[0]).toBe(0x1f);
  expect(buf[1]).toBe(0x8b);
  // ustar at offset 257 of the gunzipped body
  const inner = gunzipSync(buf);
  expect(inner.slice(257, 262).toString('ascii')).toBe('ustar');

  // List entries: meta.json + dump.ndjson must be present.
  const entries = await listTarEntries(path);
  expect(entries).toContain('meta.json');
  expect(entries).toContain('dump.ndjson');
});

test('Download with checkbox OFF → legacy .oodump.gz (no tar header)', async ({ page }) => {
  await page.goto('/#/settings');
  await page.getByTestId('settings-tab-backup').click();
  await page.getByTestId('backup-include-artifacts').uncheck();
  await page.getByTestId('backup-scope-none').click();

  const dl = page.waitForEvent('download');
  await page.getByTestId('backup-download-btn').click();
  const download = await dl;
  const name = download.suggestedFilename();
  expect(name).toMatch(/\.oodump\.gz$/);
  expect(name).not.toMatch(/\.tar\.gz$/);

  const buf = readFileSync(await download.path());
  const inner = gunzipSync(buf);
  // Raw NDJSON: first byte is '{' (manifest line JSON), not a tar header.
  expect(inner[0]).toBe(0x7b); // '{'
  expect(inner.slice(257, 262).toString('ascii')).not.toBe('ustar');
});

test('full UI round-trip with artifacts (RustFS byte equality)', async ({
  page,
  request,
  baseURL,
  shot,
}) => {
  // Snapshot the bearer so afterAll can log it if login breaks post-restore.
  const apiKeySnapshot = process.env.OO_E2E_API_KEY;

  // Late import — same Bun in-process runner as the rest of the harness;
  // no aws-sdk dep, no debug endpoint.
  const { isStorageConfigured, putObject, getObjectResponse, deleteObject } = await import(
    '../../src/services/object-storage.ts'
  );
  test.skip(
    !isStorageConfigured(),
    'no OO_OBJECT_STORAGE_* configured — artifacts UI round-trip needs RustFS',
  );

  // Seed under a unique prefix — wipe ONLY this prefix later; never the
  // whole bucket (dev RustFS has live QA artifacts).
  const prefix = `e2e-backup-${uniqueSuffix()}/`;
  const seeded = [
    { key: `${prefix}script.spec.ts`, body: Buffer.from("test('hi',()=>{});\n", 'utf8') },
    { key: `${prefix}trace.zip`, body: randomBytes(2048) },
    { key: `${prefix}screenshot.png`, body: randomBytes(1024) },
  ].map((o) => ({ ...o, sha: createHash('sha256').update(o.body).digest('hex') }));

  try {
    for (const o of seeded) await putObject(o.key, o.body, 'application/octet-stream');

    await page.goto('/#/settings');
    await page.getByTestId('settings-tab-backup').click();
    await expect(page.getByTestId('backup-include-artifacts')).toBeChecked();
    await page.getByTestId('backup-scope-none').click();
    const dl = page.waitForEvent('download');
    await page.getByTestId('backup-download-btn').click();
    const backup = await (await dl).path();

    // Pre-flight on the tar.gz envelope.
    preflightTarDump(backup, apiKeySnapshot);

    // Wipe the seeded keys so the restore has to actually put them back.
    for (const o of seeded) await deleteObject(o.key);

    await page.locator('#s-backup-file').setInputFiles(backup);
    await page.locator('#s-backup-restore').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await shot('artifacts_restore_confirm');
    await page.getByTestId('confirm-ok').click();
    await expect(page.locator('#alert-dialog')).toContainText(/restored/i, {
      timeout: 60_000,
    });
    await shot('artifacts_restore_done');

    // Byte-equality on every seeded object.
    for (const o of seeded) {
      const res = await getObjectResponse(o.key);
      const buf = Buffer.from(await res.arrayBuffer());
      const got = createHash('sha256').update(buf).digest('hex');
      expect(got, `${o.key} byte equality`).toBe(o.sha);
    }
  } finally {
    for (const o of seeded) await deleteObject(o.key).catch(() => {});
  }
});

// ---------- helpers ----------

// Read a tar.gz, return entry names. Used to assert the dump envelope shape.
async function listTarEntries(path: string): Promise<string[]> {
  const names: string[] = [];
  const extract = tar.extract();
  extract.on('entry', (header, stream, next) => {
    names.push(header.name);
    stream.on('end', next);
    stream.resume();
  });
  await pipeline(Readable.from(readFileSync(path)), createGunzip(), extract);
  return names;
}

// Auth-data safety on the destructive round-trip: peek inside the tar.gz
// envelope before any TRUNCATE, fail fast if the snapshot is empty or
// auth tables are missing. Mid-test crash → operator can recover via the
// captured OO_E2E_API_KEY logged on failure.
function preflightTarDump(path: string, keySnapshot: string | undefined) {
  try {
    const buf = readFileSync(path);
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
    const inner = gunzipSync(buf);
    if (inner.slice(257, 262).toString('ascii') !== 'ustar') {
      throw new Error('tar header missing in envelope');
    }
    // Quick sanity: dump.ndjson rows use {"t":"<table>","r":{...}}.
    if (!inner.includes(Buffer.from('"t":"users"'))) {
      throw new Error('users rows missing from tar envelope dump.ndjson');
    }
    if (!inner.includes(Buffer.from('"t":"api_keys"'))) {
      throw new Error('api_keys rows missing from tar envelope dump.ndjson');
    }
  } catch (e) {
    if (keySnapshot) {
      console.error(`[backup-e2e] pre-flight FAILED — auth bearer snapshot: ${keySnapshot}`);
    }
    throw e;
  }
}
