/**
 * QA-on-agents end-to-end integration test.
 * Ported from scripts/qa-on-agents-test.ts.
 *
 * Drives the full flow: boot master in-process, create region + agent key,
 * stand up a throwaway HTTP target, run handleQaJob() directly against
 * the in-process master, assert artifacts in object storage.
 *
 * Skips gracefully when OO_OBJECT_STORAGE_* env vars are not set.
 * Playwright must be installed (the qa-project worker uses it).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { acquireRedisDb, freePort, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { isStorageConfigured, getObject } from '../../src/services/object-storage.ts';
import { handleQaJob, type JobPayload } from '../../src/agent.ts';
import { createRegionWithKey, deleteRegion } from '../../src/services/region-admin.ts';
import { popJobForRegion } from '../../src/services/agent-dispatch.ts';
import {
  monitorRegions,
  qaGeneratedTests,
  qaProjects,
  qaTestExecutions,
} from '../../src/db/schema.ts';

const ts = Date.now();
const REGION_SLUG = `qa-agent-it-${ts}`;
const ALT_REGION_SLUG = `qa-agent-it-alt-${ts}`;
const PROJECT_NAME = `qa-agent-e2e-${ts}`;
const TEST_NAME = `failing-${ts}`;

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let targetServerClose: (() => void) | null = null;
let targetUrl = '';
let masterUrl = '';
let region: Awaited<ReturnType<typeof createRegionWithKey>> | null = null;
let altRegion: Awaited<ReturnType<typeof createRegionWithKey>> | null = null;
let projectId = -1;
let failingTestId = -1;
let passingTestId = -1;
let lightTestId = -1;
let dispatchTestId = -1;

const failingScript = (url: string) => `
import { test, expect } from '@playwright/test';
test('intentionally fails to produce trace + screenshot artifacts', async ({ page }) => {
  await page.goto('${url}');
  await expect(page.locator('#does-not-exist')).toBeVisible({ timeout: 1500 });
});
`.trim();

const passingScript = (url: string) => `
import { test, expect } from '@playwright/test';
test('passing run produces no artifacts', async ({ page }) => {
  await page.goto('${url}');
  await expect(page.locator('h1')).toBeVisible();
});
`.trim();

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  masterUrl = serverCtx.url;

  const targetServer = createHttpServer((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><h1>oo-agent-e2e</h1></body></html>'),
  );
  await new Promise<void>((r) => targetServer.listen(0, '127.0.0.1', r));
  targetUrl = `http://127.0.0.1:${(targetServer.address() as AddressInfo).port}/`;
  targetServerClose = () => targetServer.close();

  region = await createRegionWithKey(REGION_SLUG, `QA Agent It ${ts}`);
  altRegion = await createRegionWithKey(ALT_REGION_SLUG, `QA Agent It Alt ${ts}`);

  const [proj] = await db
    .insert(qaProjects)
    .values({ name: PROJECT_NAME, targetUrl } as never)
    .returning();
  projectId = proj.id;

  const [failRow] = await db
    .insert(qaGeneratedTests)
    .values({ projectId, testName: TEST_NAME, script: failingScript(targetUrl) } as never)
    .returning();
  failingTestId = failRow.id;

  const [passRow] = await db
    .insert(qaGeneratedTests)
    .values({ projectId, testName: `passing-${ts}`, script: passingScript(targetUrl) } as never)
    .returning();
  passingTestId = passRow.id;

  const [lightRow] = await db
    .insert(qaGeneratedTests)
    .values({ projectId, testName: `light-${ts}`, script: failingScript(targetUrl) } as never)
    .returning();
  lightTestId = lightRow.id;

  const [dispatchRow] = await db
    .insert(qaGeneratedTests)
    .values({ projectId, testName: `dispatch-${ts}`, script: failingScript(targetUrl) } as never)
    .returning();
  dispatchTestId = dispatchRow.id;

  await db
    .insert(monitorRegions)
    .values({ monitorType: 'qa', monitorId: projectId, regionId: region.region.id });
}, 60_000);

afterAll(async () => {
  if (projectId > 0) {
    await db.delete(qaTestExecutions).where(eq(qaTestExecutions.projectId, projectId)).catch(() => {});
    await db.delete(qaGeneratedTests).where(eq(qaGeneratedTests.projectId, projectId)).catch(() => {});
    await db.delete(monitorRegions).where(and(eq(monitorRegions.monitorType, 'qa'), eq(monitorRegions.monitorId, projectId))).catch(() => {});
    await db.delete(qaProjects).where(eq(qaProjects.id, projectId)).catch(() => {});
  }
  if (region) await deleteRegion(region.region.id).catch(() => {});
  if (altRegion) await deleteRegion(altRegion.region.id).catch(() => {});
  if (targetServerClose) targetServerClose();
  if (serverCtx) await serverCtx.stop();
  if (redisCtx) await redisCtx.releaseDb();
}, 30_000);

function agentCtx() {
  return {
    masterUrl,
    agentKey: region!.cleartextKey,
    regionSlug: REGION_SLUG,
    pollWaitSec: 1,
    tlsInsecure: false,
  };
}

describe.skipIf(!isStorageConfigured())('qa-on-agents', () => {
  test('NEG. alt region creating exec for unbound project → 403', async () => {
    const res = await fetch(`${masterUrl}/api/agent/qa/executions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${altRegion!.cleartextKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, testIds: [failingTestId] }),
    });
    expect(res.status).toBe(403);
  });

  test('A-C. failing test → FAILED status row attributed to region', async () => {

    await handleQaJob(agentCtx(), {
      jobId: `qa-test:${projectId}:${ts}`,
      type: 'qa',
      executionId: 0,
      regionId: region!.region.id,
      projectId,
      targetUrl,
      tests: [{ id: failingTestId, name: TEST_NAME, script: failingScript(targetUrl) }],
    } as JobPayload);

    const rows = await db.select().from(qaTestExecutions)
      .where(and(eq(qaTestExecutions.projectId, projectId), eq(qaTestExecutions.testId, failingTestId)));
    expect(rows.length).toBe(1);
    expect(rows[0].regionId).toBe(region!.region.id);
    expect(rows[0].status).toBe('FAILED');
  }, 60_000);

  test('D-E. failing test artifacts: trace_url + screenshot_urls populated', async () => {

    const [exec] = await db.select().from(qaTestExecutions)
      .where(and(eq(qaTestExecutions.projectId, projectId), eq(qaTestExecutions.testId, failingTestId)));
    expect(exec).toBeDefined();
    expect(exec.traceUrl).toBeTruthy();
    expect(exec.traceUrl?.endsWith('/trace.zip')).toBe(true);
    expect(Array.isArray(exec.screenshotUrls) && exec.screenshotUrls.length > 0).toBe(true);
  });

  test('F. trace.zip retrievable from object storage', async () => {

    const [exec] = await db.select().from(qaTestExecutions)
      .where(and(eq(qaTestExecutions.projectId, projectId), eq(qaTestExecutions.testId, failingTestId)));
    const body = await getObject(exec.traceUrl);
    expect(body.length).toBeGreaterThan(0);
  });

  test('G-J. passing test → SUCCESS, null artifact columns', async () => {

    await handleQaJob(agentCtx(), {
      jobId: `qa-test-pass:${projectId}:${ts}`,
      type: 'qa',
      executionId: 0,
      regionId: region!.region.id,
      projectId,
      targetUrl,
      tests: [{ id: passingTestId, name: `passing-${ts}`, script: passingScript(targetUrl) }],
    } as JobPayload);

    const rows = await db.select().from(qaTestExecutions)
      .where(and(eq(qaTestExecutions.projectId, projectId), eq(qaTestExecutions.testId, passingTestId)));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('SUCCESS');
    expect(rows[0].traceUrl).toBeNull();
    expect(rows[0].screenshotUrls).toBeNull();
  }, 60_000);

  test('K-M. OO_AGENT_FORCE_LIGHT=1 → ERROR with redeploy message', async () => {

    process.env.OO_AGENT_FORCE_LIGHT = '1';
    try {
      await handleQaJob(agentCtx(), {
        jobId: `qa-test-light:${projectId}:${ts}`,
        type: 'qa',
        executionId: 0,
        regionId: region!.region.id,
        projectId,
        targetUrl,
        tests: [{ id: lightTestId, name: `light-${ts}`, script: failingScript(targetUrl) }],
      } as JobPayload);
    } finally {
      delete process.env.OO_AGENT_FORCE_LIGHT;
    }

    const rows = await db.select().from(qaTestExecutions)
      .where(and(eq(qaTestExecutions.projectId, projectId), eq(qaTestExecutions.testId, lightTestId)));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('ERROR');
    expect(rows[0].errorMessage?.includes('observeone/oo-agent-qa')).toBe(true);
  }, 30_000);

  test('N-O. dispatcher round-trip: lpush → popJobForRegion → handleQaJob', async () => {

    const connection = new Redis(redisCtx.redisUrl, { maxRetriesPerRequest: null });

    await connection.del(`oo:jobs:${REGION_SLUG}`);

    const dispatchPayload = {
      jobId: `qa-test-dispatch:${projectId}:${ts}`,
      type: 'qa' as const,
      executionId: 0,
      regionId: region!.region.id,
      kind: 'qa-project-run',
      projectId,
      targetUrl,
      tests: [{ id: dispatchTestId, name: `dispatch-${ts}`, script: failingScript(targetUrl) }],
      triggeredAt: new Date().toISOString(),
    };
    await connection.lpush(`oo:jobs:${REGION_SLUG}`, JSON.stringify(dispatchPayload));

    const popped = await popJobForRegion(connection, REGION_SLUG, 2);
    expect(popped).not.toBeNull();
    expect((popped as { projectId?: number }).projectId).toBe(projectId);

    await handleQaJob(agentCtx(), popped as unknown as JobPayload);

    const rows = await db.select().from(qaTestExecutions)
      .where(and(eq(qaTestExecutions.projectId, projectId), eq(qaTestExecutions.testId, dispatchTestId)));
    expect(rows.length).toBe(1);
    expect(rows[0].regionId).toBe(region!.region.id);

    await connection.quit();
  }, 60_000);
});
