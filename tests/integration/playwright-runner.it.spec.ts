/**
 * executePlaywrightTest end-to-end (it actually spawns
 * `npx playwright test`). Covers two bug fixes from 2026-05-25:
 *
 *  A. targetUrl is injected as PLAYWRIGHT_TARGET_URL so scripts don't
 *     have to hard-code the URL inline.
 *  B. Runner crashes that exit before any test runs (bad import etc.)
 *     surface stderr in the returned `error` instead of the generic
 *     "Command failed with exit code 1".
 *
 * Skipped when @playwright/test is not installed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { executePlaywrightTest } from '../../src/services/playwright.service.ts';

// playwright.config.ts pins testDir to ./tests, so the spec files this
// test writes must live there too — Playwright silently finds 0 tests
// for paths outside the configured testDir.
let runDir = '';
let canRun = true;

beforeAll(async () => {
  try {
    require.resolve('@playwright/test');
  } catch {
    canRun = false;
    console.warn('[playwright-runner.it] @playwright/test not installed — SKIPPED');
    return;
  }
  runDir = path.resolve(
    process.cwd(),
    'tests',
    `_playwright-runner-it-${Date.now()}`,
  );
  await mkdir(runDir, { recursive: true });
}, 30_000);

afterAll(async () => {
  if (runDir) await rm(runDir, { recursive: true, force: true });
}, 30_000);

describe('executePlaywrightTest — env injection + crash surfacing', () => {
  test('A. PLAYWRIGHT_TARGET_URL reaches the spawned process', async () => {
    if (!canRun) return;
    // Spec that *only* passes if the env var matches the URL we passed.
    // No network — we just read process.env inside the test.
    const expectedUrl = 'https://example.com/health';
    const specPath = path.join(runDir, 'env-check.spec.ts');
    await writeFile(
      specPath,
      `import { test, expect } from '@playwright/test';
test('env injected', () => {
  expect(process.env.PLAYWRIGHT_TARGET_URL).toBe(${JSON.stringify(expectedUrl)});
});
`,
    );

    const result = await executePlaywrightTest(
      path.relative(process.cwd(), specPath),
      expectedUrl,
      undefined,
      { outputDir: path.join(runDir, 'env-check-out') },
    );

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  }, 120_000);

  test('B. runner crash → error includes the actual stderr, not just exit-code msg', async () => {
    if (!canRun) return;
    // Spec that fails to import — Playwright exits before any test runs.
    const specPath = path.join(runDir, 'bad-import.spec.ts');
    await writeFile(
      specPath,
      `import { test } from '@playwright/test';
import nope from 'this-module-does-not-exist';
test('never runs', () => { nope(); });
`,
    );

    const result = await executePlaywrightTest(
      path.relative(process.cwd(), specPath),
      'https://example.com',
      undefined,
      { outputDir: path.join(runDir, 'bad-import-out') },
    );

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // Pre-fix this was the bare "Command failed with exit code 1".
    expect(result.error).toMatch(/this-module-does-not-exist|Cannot find/i);
    expect(result.error).toMatch(/Playwright runner failed/);
  }, 120_000);
});
