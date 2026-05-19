#!/usr/bin/env bun
/**
 * Gating regression test for QA-project alerting (maybeAlertOnQaRunTransition).
 *
 * QA monitors write N qa_test_executions rows per run (one per test), so
 * the transition is a per-*run* aggregate, not the single-row flip the
 * other monitor types use. This drives the real service against the
 * integration DB: a webhook channel bound to a throwaway QA project,
 * pointed at a local catch-all HTTP server, then exercises the full
 * transition table.
 *
 * Anti-vacuous by construction (the five rows below): a stuck-dispatch
 * regression fails the three no-alert rows; a stuck-no-dispatch fails
 * the two transition rows. Either direction is caught. Payload shape is
 * asserted (event + monitor.type/target/id), not just "a POST arrived" —
 * that JSON is what webhook/Discord/Slack receivers actually parse.
 *
 * Mutates the integration DB (smoke.ts posture): unique names, cleaned
 * up in a finally. Run standalone: `bun scripts/qa-alerting-test.ts`
 * Also a stage in scripts/run-integration.sh (pre-push + CI).
 */

import { createServer, type Server } from 'node:http';
import { eq } from 'drizzle-orm';
import { db } from '../src/config/db.ts';
import { qaTestExecutions } from '../src/db/schema.ts';
import { qaProjectRepo } from '../src/db/repositories/qa-project.repo.ts';
import {
  alertChannelRepo,
  monitorAlertChannelRepo,
} from '../src/db/repositories/alert-channel.repo.ts';
import { maybeAlertOnQaRunTransition } from '../src/services/transition-detector.ts';

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

interface Hook {
  event?: string;
  status?: string;
  monitor?: { type?: string; id?: number; target?: string; name?: string };
}

// Local catch-all: collects parsed webhook bodies. Responds 200 only
// after the body is read, so `await maybeAlertOnQaRunTransition` (which
// awaits dispatch → fetch → this response) is a deterministic barrier —
// no sleeps.
const received: Hook[] = [];
const server: Server = createServer((req, res) => {
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
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const addr = server.address();
if (!addr || typeof addr !== 'object') {
  console.error('no server address');
  process.exit(1);
}
const hookUrl = `http://127.0.0.1:${addr.port}/hook`;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
let projectId = 0;
let channelId = 0;
let testId = 0;

try {
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

  // Seed a previous run as a batch of test-exec rows at `when`.
  async function seedPrevRun(statuses: string[], when: Date) {
    await db.delete(qaTestExecutions).where(eq(qaTestExecutions.projectId, projectId));
    if (statuses.length === 0) return;
    await db
      .insert(qaTestExecutions)
      .values(statuses.map((status) => ({ testId, projectId, status, startedAt: when })));
  }

  // One transition-table case: seed the previous run, invoke for this
  // run's aggregate, assert what (if anything) the webhook received.
  async function runCase(
    label: string,
    prev: string[],
    outcome: 'SUCCESS' | 'FAILED',
    expect: { event: 'outage' | 'recovery' } | null,
  ) {
    const base = Date.now();
    await seedPrevRun(prev, new Date(base));
    received.length = 0;
    // Run starts well after the seeded batch (outside the ±30s bucket).
    await maybeAlertOnQaRunTransition(projectId, new Date(base + 5 * 60_000), outcome);

    if (expect === null) {
      check(`${label}: no alert`, received.length === 0, JSON.stringify(received));
      return;
    }
    const h = received[0];
    check(
      `${label}: ${expect.event} alert with correct shape`,
      received.length === 1 &&
        h?.event === expect.event &&
        h?.monitor?.type === 'qa' &&
        h?.monitor?.target === 'browser script' &&
        h?.monitor?.id === projectId &&
        h?.status === outcome,
      JSON.stringify(received),
    );
  }

  // The anti-vacuous transition table.
  await runCase('first run (no prior)', [], 'FAILED', null);
  await runCase('up → down', ['passed', 'passed'], 'FAILED', { event: 'outage' });
  await runCase('down → up (was failed)', ['passed', 'failed'], 'SUCCESS', { event: 'recovery' });
  await runCase('down → up (was error)', ['error'], 'SUCCESS', { event: 'recovery' });
  await runCase('up → up (noop)', ['passed', 'passed'], 'SUCCESS', null);
  await runCase('down → down (noop)', ['failed'], 'FAILED', null);
} finally {
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
  try {
    if (projectId) await qaProjectRepo.deleteById(projectId);
  } catch {
    /* best-effort */
  }
  await new Promise<void>((r) => server.close(() => r()));
}

console.log(failed ? '\nqa-alerting-test: FAILED' : '\nqa-alerting-test: all checks passed');
process.exit(failed ? 1 : 0);
