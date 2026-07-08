/**
 * DB-only gating test for QA-project run-level alerting (qa_runs model).
 *
 * A QA run is grouped by a qa_runs row (per project + region). The transition
 * detector compares a completed run against the previous completed run for the
 * SAME (projectId, regionId). This test drives the detector and the repo
 * completion/idempotency helpers directly against the session DB (DATABASE_URL
 * set by setup.ts). It does NOT start a server or workers.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { db } from '../../src/config/db.ts';
import { apiKeys, qaRuns, qaTestExecutions, regions } from '../../src/db/schema.ts';
import { qaProjectRepo } from '../../src/db/repositories/qa-project.repo.ts';
import {
  alertChannelRepo,
  monitorAlertChannelRepo,
} from '../../src/db/repositories/alert-channel.repo.ts';
import { maybeAlertOnQaRunTransition } from '../../src/services/transition-detector.ts';
import { eq } from 'drizzle-orm';

interface Hook {
  event?: string;
  status?: string;
  monitor?: { type?: string; id?: number; target?: string; name?: string };
}

const received: Hook[] = [];
let hookServer: Server | null = null;
let hookUrl = '';
let projectId = 0;
let channelId = 0;
let testId = 0;
let regionAId = 0;
let regionBId = 0;
let apiKeyAId = 0;
let apiKeyBId = 0;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

beforeAll(async () => {
  hookServer = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        received.push(JSON.parse(buf) as Hook);
      } catch {
        received.push({});
      }
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => hookServer!.listen(0, '127.0.0.1', r));
  const addr = hookServer!.address();
  if (!addr || typeof addr !== 'object') throw new Error('no server address');
  hookUrl = `http://127.0.0.1:${addr.port}/hook`;

  const [proj] = await qaProjectRepo.create({
    name: `qa-alert-test-${suffix}`,
    targetUrl: 'https://example.com',
    config: { headed: false },
  });
  projectId = proj.id;
  const [gt] = await qaProjectRepo.createTest(projectId, {
    testName: 't1',
    script: "test('t', async () => {});",
  });
  testId = gt.id;
  const [ch] = await alertChannelRepo.create({
    name: `qa-alert-ch-${suffix}`,
    type: 'webhook',
    config: { url: hookUrl },
  });
  channelId = ch.id;
  await monitorAlertChannelRepo.set('qa', projectId, [channelId]);

  // Two regions for the per-region isolation test. regions.api_key_id is
  // unique (one region per key), so create a key per region.
  const [keyA] = await db
    .insert(apiKeys)
    .values({ name: `qa-key-a-${suffix}`, keyPrefix: `qaa${suffix}`.slice(0, 20), keyHash: 'x' })
    .returning({ id: apiKeys.id });
  const [keyB] = await db
    .insert(apiKeys)
    .values({ name: `qa-key-b-${suffix}`, keyPrefix: `qab${suffix}`.slice(0, 20), keyHash: 'x' })
    .returning({ id: apiKeys.id });
  apiKeyAId = keyA.id;
  apiKeyBId = keyB.id;
  const [rA] = await db
    .insert(regions)
    .values({ slug: `qa-a-${suffix}`, label: 'A', apiKeyId: apiKeyAId })
    .returning({ id: regions.id });
  const [rB] = await db
    .insert(regions)
    .values({ slug: `qa-b-${suffix}`, label: 'B', apiKeyId: apiKeyBId })
    .returning({ id: regions.id });
  regionAId = rA.id;
  regionBId = rB.id;
});

afterAll(async () => {
  try {
    if (projectId) await monitorAlertChannelRepo.set('qa', projectId, []);
  } catch {
    /* best-effort */
  }
  try {
    if (channelId) await alertChannelRepo.deleteById(channelId);
  } catch {
    /* best-effort */
  }
  // qa_runs / qa_test_executions cascade from the project; regions cascade-null
  // qa_runs.region_id, so delete the project then the regions + key.
  try {
    if (projectId) await qaProjectRepo.deleteById(projectId);
  } catch {
    /* best-effort */
  }
  try {
    if (regionAId) await db.delete(regions).where(eq(regions.id, regionAId));
    if (regionBId) await db.delete(regions).where(eq(regions.id, regionBId));
    if (apiKeyAId) await db.delete(apiKeys).where(eq(apiKeys.id, apiKeyAId));
    if (apiKeyBId) await db.delete(apiKeys).where(eq(apiKeys.id, apiKeyBId));
  } catch {
    /* best-effort */
  }
  await new Promise<void>((r) => hookServer?.close(() => r()));
});

/** Insert a completed qa_runs row (outcome pre-set) at `when` for a region. */
async function seedRun(
  outcome: 'SUCCESS' | 'FAILED',
  when: Date,
  regionId: number | null,
): Promise<void> {
  await db
    .insert(qaRuns)
    .values({ projectId, regionId, expectedTests: 1, outcome, alertedAt: when, startedAt: when });
}

/** Insert the run under test (already aggregated), then drive the detector. */
async function detect(
  prev: 'SUCCESS' | 'FAILED' | null,
  cur: 'SUCCESS' | 'FAILED',
  regionId: number | null = null,
): Promise<Hook[]> {
  await db.delete(qaRuns).where(eq(qaRuns.projectId, projectId));
  received.length = 0;
  const base = Date.now();
  if (prev) await seedRun(prev, new Date(base), regionId);
  const [run] = await db
    .insert(qaRuns)
    .values({
      projectId,
      regionId,
      expectedTests: 1,
      outcome: cur,
      alertedAt: new Date(base + 5 * 60_000),
      startedAt: new Date(base + 5 * 60_000),
    })
    .returning({ id: qaRuns.id });
  await maybeAlertOnQaRunTransition(run.id);
  return [...received];
}

describe('qa-alerting transition table (run-based)', () => {
  test('first run (no prior) → no alert', async () => {
    expect((await detect(null, 'FAILED')).length).toBe(0);
  });

  test('up → down: outage alert fired', async () => {
    const hooks = await detect('SUCCESS', 'FAILED');
    expect(hooks.length).toBe(1);
    expect(hooks[0].event).toBe('outage');
    expect(hooks[0].monitor?.type).toBe('qa');
    expect(hooks[0].monitor?.id).toBe(projectId);
    expect(hooks[0].status).toBe('FAILED');
  });

  test('down → up: recovery alert fired', async () => {
    const hooks = await detect('FAILED', 'SUCCESS');
    expect(hooks.length).toBe(1);
    expect(hooks[0].event).toBe('recovery');
    expect(hooks[0].status).toBe('SUCCESS');
  });

  test('up → up: no alert', async () => {
    expect((await detect('SUCCESS', 'SUCCESS')).length).toBe(0);
  });

  test('down → down: no alert', async () => {
    expect((await detect('FAILED', 'FAILED')).length).toBe(0);
  });
});

describe('qa-alerting is region-scoped', () => {
  test('a down run in region B does NOT compare against region A history', async () => {
    await db.delete(qaRuns).where(eq(qaRuns.projectId, projectId));
    received.length = 0;
    const base = Date.now();
    // Region A was up; region B's first-ever run is down. Cross-region blending
    // (the old project-only detector) would fire an outage; per-region must not.
    await seedRun('SUCCESS', new Date(base), regionAId);
    const [runB] = await db
      .insert(qaRuns)
      .values({
        projectId,
        regionId: regionBId,
        expectedTests: 1,
        outcome: 'FAILED',
        alertedAt: new Date(base + 1000),
        startedAt: new Date(base + 1000),
      })
      .returning({ id: qaRuns.id });
    await maybeAlertOnQaRunTransition(runB.id);
    expect(received.length).toBe(0);
  });
});

describe('qa run completion + one-shot claim', () => {
  test('runProgress reports completion and downCount; claimRunAlert is idempotent', async () => {
    const [run] = await qaProjectRepo.createRun({
      projectId,
      regionId: regionAId,
      expectedTests: 2,
    });
    const [e1] = await qaProjectRepo.createExecution(testId, projectId, 'running', regionAId, run.id);
    const [e2] = await qaProjectRepo.createExecution(testId, projectId, 'running', regionAId, run.id);

    let p = await qaProjectRepo.runProgress(run.id);
    expect(p?.completed).toBe(0);

    await qaProjectRepo.updateExecution(e1.id, { status: 'SUCCESS', completedAt: new Date() });
    p = await qaProjectRepo.runProgress(run.id);
    expect(p?.completed).toBe(1);
    expect(p!.completed >= p!.expectedTests).toBe(false); // not done yet

    await qaProjectRepo.updateExecution(e2.id, { status: 'FAILED', completedAt: new Date() });
    p = await qaProjectRepo.runProgress(run.id);
    expect(p?.completed).toBe(2);
    expect(p?.downCount).toBe(1); // one FAILED → aggregate is FAILED

    // Exactly one caller wins the claim.
    expect(await qaProjectRepo.claimRunAlert(run.id, 'FAILED')).toBe(true);
    expect(await qaProjectRepo.claimRunAlert(run.id, 'FAILED')).toBe(false);

    await db.delete(qaRuns).where(eq(qaRuns.id, run.id));
  });
});
