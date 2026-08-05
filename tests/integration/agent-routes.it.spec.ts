/**
 * /api/agent/* branch coverage that qa-on-agents.it.spec.ts (the happy-path
 * QA-run flow) and agent-tls.it.spec.ts (TLS gating on the agent's own HTTP
 * client) don't exercise: GET /me, the /jobs 204-on-empty branch, /results
 * body-validation + ownership-mismatch, /qa/executions body validation +
 * unknown-testIds, and /qa/artifacts param validation + not-found/wrong-region.
 *
 * Object-storage failure branches (isStorageConfigured()===false, and a
 * genuine putObjectStream() throw) are deliberately NOT covered here: storage
 * config is read once and memoised at process start (tests/integration/setup.ts),
 * shared by every .it.spec.ts file in this run — including qa-on-agents.it.spec.ts,
 * which does real artifact uploads. Flipping that global config mid-suite to
 * force a failure would race with those concurrent uploads.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { like } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { apiKeys, qaProjects } from '../../src/db/schema.ts';
import { apiKeyRepo } from '../../src/db/repositories/api-key.repo.ts';
import { qaProjectRepo } from '../../src/db/repositories/qa-project.repo.ts';
import { monitorRegionRepo } from '../../src/db/repositories/region.repo.ts';
import { KEY_PREFIX_LEN } from '../../src/middleware/auth.ts';
import { createRegionWithKey, deleteRegion } from '../../src/services/region-admin.ts';

const ts = Date.now();
const TAG = `agentrt-${ts}`;
const REGION_SLUG = `${TAG}-region`;
const ALT_REGION_SLUG = `${TAG}-alt-region`;

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let region: Awaited<ReturnType<typeof createRegionWithKey>>;
let altRegion: Awaited<ReturnType<typeof createRegionWithKey>>;
let agentHdr: Record<string, string>;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

  region = await createRegionWithKey(REGION_SLUG, `Agent Routes It ${ts}`);
  altRegion = await createRegionWithKey(ALT_REGION_SLUG, `Agent Routes It Alt ${ts}`);
  agentHdr = { Authorization: `Bearer ${region.cleartextKey}`, 'content-type': 'application/json' };
}, 30_000);

afterAll(async () => {
  try {
    await db.delete(qaProjects).where(like(qaProjects.name, `${TAG}%`));
    await db.delete(apiKeys).where(like(apiKeys.name, `${TAG}%`));
  } catch {
    /* best-effort cleanup */
  }
  await deleteRegion(region.region.id).catch(() => {});
  await deleteRegion(altRegion.region.id).catch(() => {});
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

describe('GET /api/agent/me', () => {
  test('valid agent key → 200 with bound region', async () => {
    const r = await fetch(`${base}/api/agent/me`, { headers: agentHdr });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { region: { slug: string } };
    expect(body.region.slug).toBe(REGION_SLUG);
  });
});

describe('GET /api/agent/jobs', () => {
  test('no queued job → 204 within the short wait window', async () => {
    const r = await fetch(`${base}/api/agent/jobs?wait=1`, { headers: agentHdr });
    expect(r.status).toBe(204);
  });
});

describe('POST /api/agent/results', () => {
  test('invalid JSON body → 400', async () => {
    const r = await fetch(`${base}/api/agent/results`, {
      method: 'POST',
      headers: agentHdr,
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });

  test('body not a JSON object (e.g. a bare number) → 400', async () => {
    const r = await fetch(`${base}/api/agent/results`, {
      method: 'POST',
      headers: agentHdr,
      body: '5',
    });
    expect(r.status).toBe(400);
  });

  test('missing type/executionId/status → 400', async () => {
    const r = await fetch(`${base}/api/agent/results`, {
      method: 'POST',
      headers: agentHdr,
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  test('execution not found / not owned by region → 403', async () => {
    const r = await fetch(`${base}/api/agent/results`, {
      method: 'POST',
      headers: agentHdr,
      body: JSON.stringify({ type: 'tcp', executionId: 999999999, status: 'SUCCESS' }),
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { reason: string };
    expect(body.reason).toBe('no_match');
  });
});

describe('POST /api/agent/qa/executions', () => {
  let projectId = -1;
  let testId = -1;

  beforeAll(async () => {
    const [project] = await qaProjectRepo.create({
      name: `${TAG}-qa-project`,
      targetUrl: 'https://example.com',
      credentials: null,
      config: {},
      intervalSeconds: 300,
      enabled: true,
      status: 'active',
    });
    projectId = project.id;
    const [t] = await qaProjectRepo.createTests(projectId, [
      { testName: 'smoke', testType: 'browser', script: 'noop', description: null },
    ]);
    testId = t.id;
    await monitorRegionRepo.set('qa', projectId, [region.region.id]);
  });

  test('invalid JSON body → 400', async () => {
    const r = await fetch(`${base}/api/agent/qa/executions`, {
      method: 'POST',
      headers: agentHdr,
      body: '{not json',
    });
    expect(r.status).toBe(400);
  });

  test('missing projectId/testIds → 400', async () => {
    const r = await fetch(`${base}/api/agent/qa/executions`, {
      method: 'POST',
      headers: agentHdr,
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  test('testIds contains a non-integer → 400', async () => {
    const r = await fetch(`${base}/api/agent/qa/executions`, {
      method: 'POST',
      headers: agentHdr,
      body: JSON.stringify({ projectId, testIds: [1.5] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/must be integers/);
  });

  test('unknown testIds for this project → 400', async () => {
    const r = await fetch(`${base}/api/agent/qa/executions`, {
      method: 'POST',
      headers: agentHdr,
      body: JSON.stringify({ projectId, testIds: [testId + 999999] }),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/unknown testIds/);
  });

  test('valid → 200, creates execution rows', async () => {
    const r = await fetch(`${base}/api/agent/qa/executions`, {
      method: 'POST',
      headers: agentHdr,
      body: JSON.stringify({ projectId, testIds: [testId] }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { executions: Array<{ testId: number; executionId: number }> };
    expect(body.executions).toHaveLength(1);
    expect(body.executions[0].testId).toBe(testId);
  });
});

describe('PUT /api/agent/qa/artifacts/:executionId/:kind', () => {
  let projectId = -1;
  let testId = -1;
  let ownExecutionId = -1;
  let altExecutionId = -1;

  beforeAll(async () => {
    const [project] = await qaProjectRepo.create({
      name: `${TAG}-qa-artifacts-project`,
      targetUrl: 'https://example.com',
      credentials: null,
      config: {},
      intervalSeconds: 300,
      enabled: true,
      status: 'active',
    });
    projectId = project.id;
    const [t] = await qaProjectRepo.createTests(projectId, [
      { testName: 'smoke', testType: 'browser', script: 'noop', description: null },
    ]);
    testId = t.id;
    const [ownExec] = await qaProjectRepo.createExecution(testId, projectId, 'running', region.region.id);
    ownExecutionId = ownExec.id;
    const [altExec] = await qaProjectRepo.createExecution(
      testId,
      projectId,
      'running',
      altRegion.region.id,
    );
    altExecutionId = altExec.id;
  });

  test('bad executionId (non-integer) → 400', async () => {
    const r = await fetch(`${base}/api/agent/qa/artifacts/not-a-number/trace`, {
      method: 'PUT',
      headers: agentHdr,
      body: 'x',
    });
    expect(r.status).toBe(400);
  });

  test('bad kind → 400', async () => {
    const r = await fetch(`${base}/api/agent/qa/artifacts/${ownExecutionId}/bogus-kind`, {
      method: 'PUT',
      headers: agentHdr,
      body: 'x',
    });
    expect(r.status).toBe(400);
  });

  test('execution not found → 404', async () => {
    const r = await fetch(`${base}/api/agent/qa/artifacts/999999999/trace`, {
      method: 'PUT',
      headers: { ...agentHdr, 'content-length': '1' },
      body: 'x',
    });
    expect(r.status).toBe(404);
  });

  test('execution owned by a different region → 403', async () => {
    const r = await fetch(`${base}/api/agent/qa/artifacts/${altExecutionId}/trace`, {
      method: 'PUT',
      headers: { ...agentHdr, 'content-length': '1' },
      body: 'x',
    });
    expect(r.status).toBe(403);
  });

  test('own execution, no body → content-length 0 → 400', async () => {
    // content-length is a forbidden header for fetch() (it's derived from the
    // body), so drive the "missing/zero content-length" branch by sending no
    // body at all — undici then omits it, and the route's
    // `Number(header ?? 0)` reads that as 0.
    const r = await fetch(`${base}/api/agent/qa/artifacts/${ownExecutionId}/trace`, {
      method: 'PUT',
      headers: agentHdr,
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/content-length/);
  });
});

describe('requireAgent() gating', () => {
  test('no credential → 401', async () => {
    const r = await fetch(`${base}/api/agent/me`);
    expect(r.status).toBe(401);
  });

  test('garbage key → 401', async () => {
    const r = await fetch(`${base}/api/agent/me`, {
      headers: { Authorization: 'Bearer oo_definitelyNotReal' },
    });
    expect(r.status).toBe(401);
  });

  test('valid key lacking agent scope → 403', async () => {
    const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
    const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
    await apiKeyRepo.create({
      name: `${TAG}-write-only-key`,
      keyPrefix: cleartext.slice(0, KEY_PREFIX_LEN),
      keyHash,
      scopes: ['write'],
    });
    const r = await fetch(`${base}/api/agent/me`, {
      headers: { Authorization: `Bearer ${cleartext}` },
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/lacks 'agent' scope/);
  });

  test('agent-scoped key not bound to any region → 403', async () => {
    const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
    const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
    await apiKeyRepo.create({
      name: `${TAG}-unbound-agent-key`,
      keyPrefix: cleartext.slice(0, KEY_PREFIX_LEN),
      keyHash,
      scopes: ['agent'],
    });
    const r = await fetch(`${base}/api/agent/me`, {
      headers: { Authorization: `Bearer ${cleartext}` },
    });
    expect(r.status).toBe(403);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/not bound to any region/);
  });
});
