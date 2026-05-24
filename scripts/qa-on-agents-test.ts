#!/usr/bin/env bun
/**
 * QA-on-agents end-to-end integration test.
 *
 * Drives the full flow exercised by PRs #74 + #75:
 *   1. Boot the real master in-process (startServer + free port)
 *   2. Create a region + agent key via region-admin (same path the UI uses)
 *   3. Stand up a tiny throwaway HTTP target so Playwright has something
 *      to navigate (no external dependency)
 *   4. Insert a QA project with a script that FAILS — guarantees trace +
 *      screenshot artifacts are produced (retain-on-failure / only-on-failure)
 *   5. Bind the project to the region via monitor_regions
 *   6. Drive the real agent handleQaJob() directly against the in-process master
 *      (skips the long-poll + scheduler — under test here is the agent→master
 *      handshake, not the dispatch path)
 *   7. Assert:
 *      - qa_test_executions row exists with the agent's region_id
 *      - status === 'FAILED' (test failed by design)
 *      - trace_url + screenshot_urls populated and retrievable from object storage
 *   8. Negative case: a SECOND region's agent key trying to create executions
 *      for the same project → 403 (region-scoped check)
 *
 * Anti-vacuous: if handleQaJob did nothing, assertion #6 fails (no row).
 * If artifact upload silently dropped, #6's URL assertions fail. If the
 * region check were missing, the negative case would 200 instead of 403.
 *
 * Run standalone: `bun scripts/qa-on-agents-test.ts`
 * Also a stage in scripts/run-integration.sh (pre-push + CI).
 *
 * RustFS is always part of the dev stack (docker-compose.dev.yml), so we
 * fail loudly if OO_OBJECT_STORAGE_* is unset — a silent skip here would
 * hide an env regression in run-integration.sh's .env loader.
 */

import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { startServer } from '../src/server.ts';
import { handleQaJob, type JobPayload } from '../src/agent.ts';
import { db } from '../src/config/db.ts';
import {
  monitorRegions,
  qaGeneratedTests,
  qaProjects,
  qaTestExecutions,
} from '../src/db/schema.ts';
import { createRegionWithKey, deleteRegion } from '../src/services/region-admin.ts';
import { getObject, isStorageConfigured } from '../src/services/object-storage.ts';

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

if (!isStorageConfigured()) {
  console.error(
    '\n❌ qa-on-agents-test: object storage not configured.\n' +
      '   RustFS is part of the dev stack — start it via docker-compose.dev.yml\n' +
      '   and ensure OO_OBJECT_STORAGE_* env vars are loaded (.env in repo root).\n',
  );
  process.exit(1);
}

const ts = Date.now();
const REGION_SLUG = `qa-agent-test-${ts}`;
const ALT_REGION_SLUG = `qa-agent-test-alt-${ts}`;
const PROJECT_NAME = `qa-agent-e2e-${ts}`;
const TEST_NAME = `failing-${ts}`;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6479';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

let stopServer: (() => Promise<void>) | null = null;
let region: Awaited<ReturnType<typeof createRegionWithKey>> | null = null;
let altRegion: Awaited<ReturnType<typeof createRegionWithKey>> | null = null;
let projectId = -1;
let targetServerClose: (() => void) | null = null;
let targetPort = 0;

try {
  const port = await freePort();
  stopServer = startServer(connection, port);
  const masterUrl = `http://127.0.0.1:${port}`;
  await new Promise((r) => setTimeout(r, 300));

  // Throwaway target so Playwright has something to navigate. The failing
  // assertion below (#does-not-exist click) is what actually drives FAILED.
  targetPort = await freePort();
  const targetServer = createHttpServer((_req, res) => {
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<html><body><h1>oo-agent-e2e</h1></body></html>');
  });
  await new Promise<void>((r) => targetServer.listen(targetPort, '127.0.0.1', r));
  targetServerClose = () => targetServer.close();
  const targetUrl = `http://127.0.0.1:${targetPort}/`;

  // Real region + agent key via the same code path the UI uses.
  region = await createRegionWithKey(REGION_SLUG, `QA Agent Test ${ts}`);
  altRegion = await createRegionWithKey(ALT_REGION_SLUG, `QA Agent Test Alt ${ts}`);

  // Real QA project + one failing test.
  const failingScript = `
import { test, expect } from '@playwright/test';
test('intentionally fails to produce trace + screenshot artifacts', async ({ page }) => {
  await page.goto('${targetUrl}');
  await expect(page.locator('#does-not-exist')).toBeVisible({ timeout: 1500 });
});
`.trim();

  const [proj] = await db
    .insert(qaProjects)
    .values({
      name: PROJECT_NAME,
      targetUrl,
      // Required-on-insert fields not all set here — qaProjects has sensible defaults
      // for credentials / config / scheduled flags. If schema is stricter, this insert
      // will fail loudly and the test reports it.
    } as never)
    .returning();
  projectId = proj.id;

  const [testRow] = await db
    .insert(qaGeneratedTests)
    .values({
      projectId,
      name: TEST_NAME,
      script: failingScript,
    } as never)
    .returning();
  const testId = testRow.id;

  // Bind the project to the region — same row a UI "check the region box" produces.
  await db
    .insert(monitorRegions)
    .values({ monitorType: 'qa', monitorId: projectId, regionId: region.region.id });

  // --- Negative case first (no executions exist yet): alt region must 403 ---
  const altCreate = await fetch(`${masterUrl}/api/agent/qa/executions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${altRegion.cleartextKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ projectId, testIds: [testId] }),
  });
  check(
    'NEG. alt region creating exec for unbound project → 403',
    altCreate.status === 403,
    `got ${altCreate.status}`,
  );

  // --- Happy path: drive the real agent handler ---
  const job: JobPayload = {
    jobId: `qa-test:${projectId}:${ts}`,
    type: 'qa',
    executionId: 0, // synthetic — handleQaJob creates per-test rows via master
    regionId: region.region.id,
    projectId,
    targetUrl,
    tests: [{ id: testId, name: TEST_NAME, script: failingScript }],
  };

  await handleQaJob(
    {
      masterUrl,
      agentKey: region.cleartextKey,
      regionSlug: REGION_SLUG,
      pollWaitSec: 1,
      tlsInsecure: false,
    },
    job,
  );

  // --- Assertions: row created with region attribution + artifacts populated ---
  const execRows = await db
    .select()
    .from(qaTestExecutions)
    .where(and(eq(qaTestExecutions.projectId, projectId), eq(qaTestExecutions.testId, testId)));

  check('A. exactly one exec row created for the agent run', execRows.length === 1);
  const exec = execRows[0];
  check(
    'B. exec row attributed to the agent region',
    exec.regionId === region.region.id,
    `got region_id=${exec.regionId}, expected ${region.region.id}`,
  );
  check(
    'C. exec status FAILED (test asserts non-existent element)',
    exec.status === 'FAILED',
    `got status=${exec.status}`,
  );
  check(
    'D. trace_url populated',
    !!exec.traceUrl && exec.traceUrl.endsWith('/trace.zip'),
    String(exec.traceUrl),
  );
  check(
    'E. screenshot_urls populated (non-empty array)',
    Array.isArray(exec.screenshotUrls) && exec.screenshotUrls.length > 0,
    JSON.stringify(exec.screenshotUrls),
  );

  // Round-trip the trace through object storage — confirms the streaming
  // PUT actually wrote bytes, not just stamped a key.
  if (exec.traceUrl) {
    try {
      const body = await getObject(exec.traceUrl);
      check('F. trace.zip retrievable from object storage (non-empty)', body.length > 0);
    } catch (err) {
      check(
        'F. trace.zip retrievable from object storage (non-empty)',
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
} catch (err) {
  console.error(
    `\n❌ test threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  failed = true;
} finally {
  // Cleanup in reverse order. Each guarded so one failure doesn't mask others.
  if (projectId > 0) {
    await db
      .delete(qaTestExecutions)
      .where(eq(qaTestExecutions.projectId, projectId))
      .catch(() => {});
    await db
      .delete(qaGeneratedTests)
      .where(eq(qaGeneratedTests.projectId, projectId))
      .catch(() => {});
    await db
      .delete(monitorRegions)
      .where(and(eq(monitorRegions.monitorType, 'qa'), eq(monitorRegions.monitorId, projectId)))
      .catch(() => {});
    await db
      .delete(qaProjects)
      .where(eq(qaProjects.id, projectId))
      .catch(() => {});
  }
  if (region) await deleteRegion(region.region.id).catch(() => {});
  if (altRegion) await deleteRegion(altRegion.region.id).catch(() => {});
  if (targetServerClose) targetServerClose();
  if (stopServer) await stopServer();
  await connection.quit().catch(() => {});
}

if (failed) {
  console.error('\n❌ qa-on-agents-test FAILED\n');
  process.exit(1);
}
console.log('\n✅ qa-on-agents-test passed\n');
