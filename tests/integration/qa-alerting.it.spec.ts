/**
 * DB-only gating test for QA-project run-level alerting (qa_runs model).
 *
 * A QA run is grouped by a qa_runs row (per project + region). The transition
 * detector compares a completed run against the previous completed run for the
 * SAME (projectId, regionId). This test drives the detector and the repo
 * completion/idempotency helpers directly against the session DB (DATABASE_URL
 * set by setup.ts). It does NOT start a server or workers.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { Redis } from 'ioredis';
import fs from 'node:fs/promises';
import { db } from '../../src/config/db.ts';
import { apiKeys, qaRuns, qaTestExecutions, regions } from '../../src/db/schema.ts';
import { qaProjectRepo } from '../../src/db/repositories/qa-project.repo.ts';
import {
  alertChannelRepo,
  monitorAlertChannelRepo,
} from '../../src/db/repositories/alert-channel.repo.ts';
import { maybeAlertOnQaRunTransition } from '../../src/services/transition-detector.ts';
import { tickAbandonedQaRuns } from '../../src/scheduler.ts';
import { createQaProjectProcessor } from '../../src/processors/qa-project.processor.ts';
import { QA_EXEC_ABANDONED, QA_RUN_ABANDONED } from '../../src/constants.ts';
import { eq } from 'drizzle-orm';

interface Hook {
  event?: string;
  status?: string;
  errorMessage?: string | null;
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

/**
 * The rotting-row case the sweep exists for: the worker (or a region agent)
 * dies mid-run, so nobody ever computes the aggregate, `outcome` stays NULL
 * forever and the executions keep claiming to be `running`. Seeds a run with
 * no outcome and an execution still marked `running`.
 */
async function seedAbandonedRun(startedAt: Date): Promise<{ runId: number; execId: number }> {
  const [run] = await db
    .insert(qaRuns)
    .values({ projectId, regionId: null, expectedTests: 1, startedAt })
    .returning({ id: qaRuns.id });
  const [exec] = await qaProjectRepo.createExecution(testId, projectId, 'running', null, run.id);
  return { runId: run.id, execId: exec.id };
}

/** Drop this project's run history and forget any hooks it delivered. */
async function resetHistory(): Promise<void> {
  await db.delete(qaRuns).where(eq(qaRuns.projectId, projectId));
  received.length = 0;
}

/**
 * The arrangement every sweep case needs: clear history, seed a prior
 * verdict, strand a run past the cutoff, sweep it. Returns the stranded ids.
 */
async function sweepRunAbandonedAfter(
  prior: 'SUCCESS' | 'FAILED',
): Promise<{ runId: number; execId: number }> {
  await resetHistory();
  await seedRun(prior, new Date(Date.now() - 3 * 60 * 60_000), null);
  const seeded = await seedAbandonedRun(new Date(Date.now() - 60 * 60_000));
  await tickAbandonedQaRuns();
  return seeded;
}

/** Insert an already-aggregated run and drive the detector over it. */
async function completeRun(outcome: 'SUCCESS' | 'FAILED', when = new Date()): Promise<void> {
  const [run] = await db
    .insert(qaRuns)
    .values({
      projectId,
      regionId: null,
      expectedTests: 1,
      outcome,
      alertedAt: when,
      startedAt: when,
    })
    .returning({ id: qaRuns.id });
  await maybeAlertOnQaRunTransition(run.id);
}

describe('abandoned qa runs are recorded, never paged', () => {
  test('a run stuck without an outcome is recorded ABANDONED and does NOT page', async () => {
    // Previously green. Under a naive "mark it FAILED" sweep this is exactly
    // the shape that would fire an outage — but the run died on OUR side, so
    // it says nothing about the target and the owner must not be paged.
    const { runId, execId } = await sweepRunAbandonedAfter('SUCCESS');

    expect(received.length).toBe(0);

    // Recorded, so the row stops rotting at NULL.
    const run = await qaProjectRepo.findRunById(runId);
    expect(run?.outcome).toBe(QA_RUN_ABANDONED);
    expect(run?.alertedAt).not.toBeNull();

    // The stranded execution stops claiming to be running, and lands on a
    // status OUTSIDE the down vocabulary — 'error' would have turned our
    // dead worker into the monitor's downtime on its public status page.
    const [exec] = await db
      .select({
        status: qaTestExecutions.status,
        completedAt: qaTestExecutions.completedAt,
        errorMessage: qaTestExecutions.errorMessage,
      })
      .from(qaTestExecutions)
      .where(eq(qaTestExecutions.id, execId));
    expect(exec.status).toBe(QA_EXEC_ABANDONED);
    expect(['FAILED', 'failed', 'ERROR', 'error']).not.toContain(exec.status);
    expect(exec.completedAt).not.toBeNull();
    expect(exec.errorMessage).toContain('abandoned');

    // Positive control: silence above has to mean "policy", not "the webhook
    // came unbound". A real failing run on the same channel still pages.
    await completeRun('FAILED');
    expect(received.length).toBe(1);
    expect(received[0].event).toBe('outage');
  });

  test('the sweep is idempotent — a second pass re-finalizes nothing', async () => {
    const { runId } = await sweepRunAbandonedAfter('SUCCESS');
    const first = await qaProjectRepo.findRunById(runId);

    await tickAbandonedQaRuns();
    const second = await qaProjectRepo.findRunById(runId);

    // claimRunAlert already won once; the second pass must not touch the row.
    expect(second?.alertedAt?.getTime()).toBe(first?.alertedAt?.getTime());
    expect(received.length).toBe(0);
  });

  test('a run younger than the cutoff is left alone', async () => {
    await resetHistory();
    await seedRun('SUCCESS', new Date(Date.now() - 3 * 60 * 60_000), null);
    // Started just now — still legitimately in flight.
    const { runId } = await seedAbandonedRun(new Date());

    await tickAbandonedQaRuns();

    expect(received.length).toBe(0);
    const run = await qaProjectRepo.findRunById(runId);
    expect(run?.outcome).toBeNull();
  });

  // The pair below is the point of excluding ABANDONED from the previous-run
  // lookup. If it were merely "outcome IS NOT NULL", the run after an
  // abandoned one would find a predecessor that normalizes to 'other', bail
  // early, and QA alerting would go permanently silent from the first
  // abandoned run onward — strictly worse than the rotting NULL row.
  // Table-driven so the three cases stay one block: written out longhand they
  // are token-identical bar the literals, and Sonar's CPD anonymizes literals
  // in TS — three near-copies would trip new_duplicated_lines_density.
  const ACROSS_ABANDONED = [
    { prior: 'SUCCESS', next: 'FAILED', expected: 'outage' },
    { prior: 'FAILED', next: 'SUCCESS', expected: 'recovery' },
    // No phantom outage on the way in, so no dangling recovery on the way out.
    { prior: 'SUCCESS', next: 'SUCCESS', expected: null },
  ] as const;

  for (const { prior, next, expected } of ACROSS_ABANDONED) {
    test(`${prior} → ABANDONED → ${next} ⇒ ${expected ?? 'silent'}`, async () => {
      await sweepRunAbandonedAfter(prior);
      expect(received.length).toBe(0); // the sweep itself never pages

      await completeRun(next);

      expect(received.map((h) => h.event)).toEqual(expected ? [expected] : []);
    });
  }
});

/**
 * The processor's own crash path. A run that throws mid-flight used to be
 * rethrown with `qa_runs.outcome` still NULL — silent until the sweep caught
 * it 15 minutes later, or forever if the row was never swept.
 *
 * Driven with an empty `tests` array so no Playwright process is launched:
 * the run still gets created, aggregated and claimed, which is every code
 * path these cases care about. Failures are injected by swapping repo
 * methods for throwing ones, restored after each case.
 */
describe('qa processor closes out a run that throws', () => {
  type QaProcessor = ReturnType<typeof createQaProjectProcessor>;
  type QaJob = Parameters<QaProcessor>[0];

  // publishUpdate only ever calls redis.publish, and swallows its errors —
  // a stub keeps the case off a live Redis connection.
  const redisStub = { publish: async () => 1 } as unknown as Redis;

  function job(): QaJob {
    return {
      id: `it-${suffix}`,
      data: {
        type: 'qa-project-run',
        projectId,
        targetUrl: 'https://example.com',
        tests: [],
        triggeredAt: new Date().toISOString(),
      },
    } as unknown as QaJob;
  }

  const realTouch = qaProjectRepo.touchLastRunAt;
  const realClaim = qaProjectRepo.claimRunAlert;

  afterEach(() => {
    qaProjectRepo.touchLastRunAt = realTouch;
    qaProjectRepo.claimRunAlert = realClaim;
  });

  test('a run with no tests aggregates SUCCESS and alerts on the flip', async () => {
    await resetHistory();
    await seedRun('FAILED', new Date(Date.now() - 60 * 60_000), null);

    await createQaProjectProcessor(redisStub)(job());

    expect(received.length).toBe(1);
    expect(received[0].event).toBe('recovery');
  });

  test('the alert survives a failing touchLastRunAt', async () => {
    await resetHistory();
    await seedRun('FAILED', new Date(Date.now() - 60 * 60_000), null);
    // Cosmetic write, but it used to sit ahead of the claim — a blip here
    // swallowed the notification entirely.
    qaProjectRepo.touchLastRunAt = () => {
      throw new Error('db blip');
    };

    await expect(createQaProjectProcessor(redisStub)(job())).rejects.toThrow('db blip');

    expect(received.length).toBe(1);
    expect(received[0].event).toBe('recovery');
  });

  test('a run that throws before aggregating is recorded ABANDONED, not paged', async () => {
    await resetHistory();
    await seedRun('SUCCESS', new Date(Date.now() - 60 * 60_000), null);
    // Blow up on the in-band claim only; the catch's own claim goes through,
    // which is exactly the "run died before it had an outcome" case.
    let first = true;
    let abortedRunId = 0;
    qaProjectRepo.claimRunAlert = (runId, outcome) => {
      if (first) {
        first = false;
        throw new Error('claim exploded');
      }
      abortedRunId = runId;
      return realClaim.call(qaProjectRepo, runId, outcome);
    };

    await expect(createQaProjectProcessor(redisStub)(job())).rejects.toThrow('claim exploded');

    // The failure was ours (the processor blew up), so nobody is paged.
    expect(received.length).toBe(0);
    const run = await qaProjectRepo.findRunById(abortedRunId);
    expect(run?.outcome).toBe(QA_RUN_ABANDONED);
  });

  test('a scratch-dir cleanup failure does not eat the verdict', async () => {
    await resetHistory();
    await seedRun('FAILED', new Date(Date.now() - 60 * 60_000), null);
    // rm sits between "every test has reported" and "claim the aggregate".
    // Unguarded, an EBUSY here threw into the catch, which claimed the run
    // ABANDONED — discarding a verdict we already had, and with it the alert.
    const realRm = fs.rm;
    (fs as { rm: unknown }).rm = () => Promise.reject(new Error('EBUSY'));
    try {
      await createQaProjectProcessor(redisStub)(job());
    } finally {
      (fs as { rm: unknown }).rm = realRm;
    }

    expect(received.length).toBe(1);
    expect(received[0].event).toBe('recovery');
  });

  test('a finalize that itself fails is swallowed, not masking the original error', async () => {
    await resetHistory();
    await seedRun('SUCCESS', new Date(Date.now() - 60 * 60_000), null);
    qaProjectRepo.claimRunAlert = () => {
      throw new Error('claim exploded');
    };

    // The original failure is what propagates — not whatever the alert path hit.
    await expect(createQaProjectProcessor(redisStub)(job())).rejects.toThrow('claim exploded');
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
