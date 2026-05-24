/**
 * DB-only gating test for QA-project alerting.
 * Ported from scripts/qa-alerting-test.ts.
 *
 * Uses the session DB (DATABASE_URL set by setup.ts).
 * Does NOT start a server or workers — calls service functions directly.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { db } from '../../src/config/db.ts';
import { qaTestExecutions } from '../../src/db/schema.ts';
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
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

beforeAll(async () => {
  hookServer = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { received.push(JSON.parse(buf) as Hook); } catch { received.push({}); }
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
});

afterAll(async () => {
  try { if (projectId) await monitorAlertChannelRepo.set('qa', projectId, []); } catch { /* best-effort */ }
  try { if (channelId) await alertChannelRepo.deleteById(channelId); } catch { /* best-effort */ }
  try { if (projectId) await qaProjectRepo.deleteById(projectId); } catch { /* best-effort */ }
  await new Promise<void>((r) => hookServer?.close(() => r()));
});

async function seedPrevRun(statuses: string[], when: Date) {
  await db.delete(qaTestExecutions).where(eq(qaTestExecutions.projectId, projectId));
  if (statuses.length === 0) return;
  await db.insert(qaTestExecutions).values(
    statuses.map((status) => ({ testId, projectId, status, startedAt: when })),
  );
}

async function runCase(
  prev: string[],
  outcome: 'SUCCESS' | 'FAILED',
): Promise<Hook[]> {
  const base = Date.now();
  await seedPrevRun(prev, new Date(base));
  received.length = 0;
  await maybeAlertOnQaRunTransition(projectId, new Date(base + 5 * 60_000), outcome);
  return [...received];
}

describe('qa-alerting transition table', () => {
  test('first run (no prior) → no alert', async () => {
    const hooks = await runCase([], 'FAILED');
    expect(hooks.length).toBe(0);
  });

  test('up → down: outage alert fired', async () => {
    const hooks = await runCase(['passed', 'passed'], 'FAILED');
    expect(hooks.length).toBe(1);
    expect(hooks[0].event).toBe('outage');
    expect(hooks[0].monitor?.type).toBe('qa');
    expect(hooks[0].monitor?.id).toBe(projectId);
    expect(hooks[0].status).toBe('FAILED');
  });

  test('down → up (was failed): recovery alert fired', async () => {
    const hooks = await runCase(['passed', 'failed'], 'SUCCESS');
    expect(hooks.length).toBe(1);
    expect(hooks[0].event).toBe('recovery');
    expect(hooks[0].status).toBe('SUCCESS');
  });

  test('down → up (was error): recovery alert fired', async () => {
    const hooks = await runCase(['error'], 'SUCCESS');
    expect(hooks.length).toBe(1);
    expect(hooks[0].event).toBe('recovery');
  });

  test('up → up: no alert', async () => {
    const hooks = await runCase(['passed', 'passed'], 'SUCCESS');
    expect(hooks.length).toBe(0);
  });

  test('down → down: no alert', async () => {
    const hooks = await runCase(['failed'], 'FAILED');
    expect(hooks.length).toBe(0);
  });
});
