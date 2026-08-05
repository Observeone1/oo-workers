/**
 * /api/monitors/* + /api/availability — coverage for the create/update/
 * enable-disable/regions/channels/run-now branches that the narrower
 * feature specs (heartbeat.it.spec.ts, sse-monitor-lifecycle.it.spec.ts,
 * api-assertion-validation.it.spec.ts) don't exercise: tcp/udp/db/tls/qa
 * create, tls expectCnRegex validation, heartbeat PATCH/PUT guards, the
 * generic PUT/PATCH/run-now dispatch, and monitor-regions/channels set.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import {
  urlMonitors,
  tcpMonitors,
  udpMonitors,
  dbMonitors,
  tlsMonitors,
  qaProjects,
  heartbeatMonitors,
  apiKeys,
} from '../../src/db/schema.ts';
import { apiKeyRepo } from '../../src/db/repositories/api-key.repo.ts';
import { KEY_PREFIX_LEN } from '../../src/middleware/auth.ts';

const ts = Date.now();
const TAG = `mrt-${ts}`;

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let writeHdr: Record<string, string>;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

  const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
  await apiKeyRepo.create({
    name: TAG,
    keyPrefix: cleartext.slice(0, KEY_PREFIX_LEN),
    keyHash,
    scopes: ['write'],
  });
  writeHdr = { Authorization: `Bearer ${cleartext}`, 'content-type': 'application/json' };
}, 30_000);

afterAll(async () => {
  try {
    await db.delete(urlMonitors).where(like(urlMonitors.name, `${TAG}%`));
    await db.delete(tcpMonitors).where(like(tcpMonitors.name, `${TAG}%`));
    await db.delete(udpMonitors).where(like(udpMonitors.name, `${TAG}%`));
    await db.delete(dbMonitors).where(like(dbMonitors.name, `${TAG}%`));
    await db.delete(tlsMonitors).where(like(tlsMonitors.name, `${TAG}%`));
    await db.delete(qaProjects).where(like(qaProjects.name, `${TAG}%`));
    await db.delete(heartbeatMonitors).where(like(heartbeatMonitors.name, `${TAG}%`));
    await db.delete(apiKeys).where(eq(apiKeys.name, TAG));
  } catch {
    /* best-effort cleanup */
  }
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

async function post(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: 'POST', headers: writeHdr, body: JSON.stringify(body) });
}
async function put(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: 'PUT', headers: writeHdr, body: JSON.stringify(body) });
}
async function patch(path: string, body: unknown) {
  return fetch(`${base}${path}`, { method: 'PATCH', headers: writeHdr, body: JSON.stringify(body) });
}

describe('GET /api/availability', () => {
  test('returns one bucket per requested day, shaped {date, total, passed}', async () => {
    const r = await fetch(`${base}/api/availability?days=7`, { headers: writeHdr });
    expect(r.status).toBe(200);
    const buckets = (await r.json()) as Array<{ date: string; total: number; passed: number }>;
    expect(buckets).toHaveLength(7);
    expect(typeof buckets[0].date).toBe('string');
    expect(typeof buckets[0].total).toBe('number');
    expect(typeof buckets[0].passed).toBe('number');
  });
});

describe('POST /api/monitors/tcp', () => {
  test('missing name/host/port → 400', async () => {
    const r = await post('/api/monitors/tcp', { name: '', host: '', port: 0 });
    expect(r.status).toBe(400);
  });

  test('valid → 201', async () => {
    const r = await post('/api/monitors/tcp', {
      name: `${TAG}-tcp`,
      host: 'example.com',
      port: 443,
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { id: number };
    expect(body.id).toBeGreaterThan(0);
  });
});

describe('POST /api/monitors/udp', () => {
  test('missing host → 400', async () => {
    const r = await post('/api/monitors/udp', { name: `${TAG}-udp-bad`, port: 53 });
    expect(r.status).toBe(400);
  });

  test('valid → 201', async () => {
    const r = await post('/api/monitors/udp', {
      name: `${TAG}-udp`,
      host: 'example.com',
      port: 53,
    });
    expect(r.status).toBe(201);
  });
});

describe('POST /api/monitors/db', () => {
  test('missing name/host/port → 400', async () => {
    const r = await post('/api/monitors/db', { protocol: 'postgres' });
    expect(r.status).toBe(400);
  });

  test('bad protocol → 400', async () => {
    const r = await post('/api/monitors/db', {
      name: `${TAG}-db-bad`,
      host: 'example.com',
      port: 5432,
      protocol: 'mongodb',
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/protocol must be/);
  });

  test('valid postgres → 201', async () => {
    const r = await post('/api/monitors/db', {
      name: `${TAG}-db`,
      host: 'example.com',
      port: 5432,
      protocol: 'postgres',
    });
    expect(r.status).toBe(201);
  });
});

describe('POST /api/monitors/tls', () => {
  test('missing name/host → 400', async () => {
    const r = await post('/api/monitors/tls', {});
    expect(r.status).toBe(400);
  });

  test('bad warnDays → 400', async () => {
    const r = await post('/api/monitors/tls', {
      name: `${TAG}-tls-bad-wd`,
      host: 'example.com',
      warnDays: -1,
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/warnDays/);
  });

  test('expectCnRegex too long (>200 chars) → 400', async () => {
    const r = await post('/api/monitors/tls', {
      name: `${TAG}-tls-long`,
      host: 'example.com',
      expectCnRegex: 'a'.repeat(201),
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/too long/);
  });

  test('expectCnRegex trivially-nested quantifier → 400', async () => {
    const r = await post('/api/monitors/tls', {
      name: `${TAG}-tls-redos`,
      host: 'example.com',
      expectCnRegex: '(a+)+',
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/nested quantifier/);
  });

  test('expectCnRegex invalid regex syntax → 400', async () => {
    const r = await post('/api/monitors/tls', {
      name: `${TAG}-tls-badregex`,
      host: 'example.com',
      expectCnRegex: '(unterminated',
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/not a valid regex/);
  });

  test('valid expectCnRegex → 201, saved verbatim', async () => {
    const r = await post('/api/monitors/tls', {
      name: `${TAG}-tls-ok`,
      host: 'example.com',
      expectCnRegex: String.raw`^example\.com$`,
    });
    expect(r.status).toBe(201);
    const body = (await r.json()) as { expectCnRegex: string };
    expect(body.expectCnRegex).toBe(String.raw`^example\.com$`);
  });
});

describe('POST /api/monitors/qa', () => {
  test('missing tests[] → 400', async () => {
    const r = await post('/api/monitors/qa', {
      name: `${TAG}-qa-bad`,
      targetUrl: 'https://example.com',
      tests: [],
    });
    expect(r.status).toBe(400);
  });

  test('valid → 201', async () => {
    const r = await post('/api/monitors/qa', {
      name: `${TAG}-qa`,
      targetUrl: 'https://example.com',
      tests: [{ name: 'smoke', script: 'await page.goto("/")' }],
    });
    expect(r.status).toBe(201);
  });
});

describe('POST /api/monitors/heartbeat create guards', () => {
  test('graceSeconds < 0 → 400', async () => {
    const r = await post('/api/monitors/heartbeat', {
      name: `${TAG}-hb-badgrace`,
      periodSeconds: 60,
      graceSeconds: -1,
    });
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/graceSeconds/);
  });
});

describe('heartbeat PATCH / PUT guards', () => {
  let hbId = -1;

  beforeAll(async () => {
    const r = await post('/api/monitors/heartbeat', { name: `${TAG}-hb`, periodSeconds: 60 });
    const body = (await r.json()) as { id: number };
    hbId = body.id;
  });

  test('PATCH bad id → 400', async () => {
    const r = await patch('/api/monitors/heartbeat/not-a-number', {});
    expect(r.status).toBe(400);
  });

  test('PATCH periodSeconds < 30 → 400', async () => {
    const r = await patch(`/api/monitors/heartbeat/${hbId}`, { periodSeconds: 5 });
    expect(r.status).toBe(400);
  });

  test('PATCH graceSeconds < 0 → 400', async () => {
    const r = await patch(`/api/monitors/heartbeat/${hbId}`, { graceSeconds: -1 });
    expect(r.status).toBe(400);
  });

  test('PATCH valid partial update → 200', async () => {
    const r = await patch(`/api/monitors/heartbeat/${hbId}`, {
      description: 'updated',
      periodSeconds: 90,
      graceSeconds: 30,
      enabled: false,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { description: string; enabled: boolean };
    expect(body.description).toBe('updated');
    expect(body.enabled).toBe(false);
  });

  test('PATCH unknown id → 404', async () => {
    const r = await patch('/api/monitors/heartbeat/999999999', { enabled: true });
    expect(r.status).toBe(404);
  });

  test('PUT bad id → 400', async () => {
    const r = await put('/api/monitors/heartbeat/not-a-number', {});
    expect(r.status).toBe(400);
  });

  test('PUT periodSeconds < 30 → 400', async () => {
    const r = await put(`/api/monitors/heartbeat/${hbId}`, { periodSeconds: 1 });
    expect(r.status).toBe(400);
  });

  test('PUT graceSeconds < 0 → 400', async () => {
    const r = await put(`/api/monitors/heartbeat/${hbId}`, { graceSeconds: -5 });
    expect(r.status).toBe(400);
  });

  test('PUT valid full update → 200', async () => {
    const r = await put(`/api/monitors/heartbeat/${hbId}`, {
      name: `${TAG}-hb-renamed`,
      periodSeconds: 120,
      graceSeconds: 10,
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { name: string; periodSeconds: number };
    expect(body.name).toBe(`${TAG}-hb-renamed`);
    expect(body.periodSeconds).toBe(120);
  });

  test('PUT unknown id → 404', async () => {
    const r = await put('/api/monitors/heartbeat/999999999', { periodSeconds: 60 });
    expect(r.status).toBe(404);
  });
});

describe('generic PUT /api/monitors/:type/:id', () => {
  let urlId = -1;

  beforeAll(async () => {
    const r = await post('/api/monitors/url', { name: `${TAG}-url`, url: 'https://example.com' });
    const body = (await r.json()) as { id: number };
    urlId = body.id;
  });

  test('bad id → 400', async () => {
    const r = await put('/api/monitors/url/not-a-number', {});
    expect(r.status).toBe(400);
  });

  test('valid update → 200', async () => {
    const r = await put(`/api/monitors/url/${urlId}`, {
      name: `${TAG}-url-renamed`,
      url: 'https://example.org',
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { name: string };
    expect(body.name).toBe(`${TAG}-url-renamed`);
  });
});

describe('regions / channels binding', () => {
  let urlId = -1;

  beforeAll(async () => {
    const r = await post('/api/monitors/url', {
      name: `${TAG}-url-bind`,
      url: 'https://example.com',
    });
    const body = (await r.json()) as { id: number };
    urlId = body.id;
  });

  test('PUT regions: bad type → 400', async () => {
    const r = await put(`/api/monitors/bogus/${urlId}/regions`, { regionIds: [] });
    expect(r.status).toBe(400);
  });

  test('PUT regions: bad id → 400', async () => {
    const r = await put('/api/monitors/url/not-a-number/regions', { regionIds: [] });
    expect(r.status).toBe(400);
  });

  test('PUT regions: regionIds not an integer array → 400', async () => {
    const r = await put(`/api/monitors/url/${urlId}/regions`, { regionIds: ['a'] });
    expect(r.status).toBe(400);
  });

  test('PUT regions: empty array → 200', async () => {
    const r = await put(`/api/monitors/url/${urlId}/regions`, { regionIds: [] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; regionIds: number[] };
    expect(body.ok).toBe(true);
    expect(body.regionIds).toEqual([]);
  });

  test('PUT channels: bad type → 400', async () => {
    const r = await put(`/api/monitors/bogus/${urlId}/channels`, { channelIds: [] });
    expect(r.status).toBe(400);
  });

  test('PUT channels: bad id → 400', async () => {
    const r = await put('/api/monitors/url/not-a-number/channels', { channelIds: [] });
    expect(r.status).toBe(400);
  });

  test('PUT channels: channelIds not an integer array → 400', async () => {
    const r = await put(`/api/monitors/url/${urlId}/channels`, { channelIds: [{}] });
    expect(r.status).toBe(400);
  });

  test('PUT channels: empty array → 200', async () => {
    const r = await put(`/api/monitors/url/${urlId}/channels`, { channelIds: [] });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; channelIds: number[] };
    expect(body.ok).toBe(true);
    expect(body.channelIds).toEqual([]);
  });
});

describe('PATCH /api/monitors/:type/:id (enable/disable)', () => {
  let urlId = -1;

  beforeAll(async () => {
    const r = await post('/api/monitors/url', {
      name: `${TAG}-url-toggle`,
      url: 'https://example.com',
    });
    const body = (await r.json()) as { id: number };
    urlId = body.id;
  });

  test('bad id → 400', async () => {
    const r = await patch('/api/monitors/url/not-a-number', { enabled: false });
    expect(r.status).toBe(400);
  });

  test('enabled not boolean → 400', async () => {
    const r = await patch(`/api/monitors/url/${urlId}`, { enabled: 'nope' });
    expect(r.status).toBe(400);
  });

  test('bad type → 400', async () => {
    const r = await patch(`/api/monitors/bogus/${urlId}`, { enabled: false });
    expect(r.status).toBe(400);
  });

  test('url type → 204', async () => {
    const r = await patch(`/api/monitors/url/${urlId}`, { enabled: false });
    expect(r.status).toBe(204);
  });
});

describe('POST /api/monitors/:type/:id/run (run-now)', () => {
  let urlId = -1;

  beforeAll(async () => {
    const r = await post('/api/monitors/url', {
      name: `${TAG}-url-run`,
      url: 'https://example.com',
    });
    const body = (await r.json()) as { id: number };
    urlId = body.id;
  });

  test('bad id → 400', async () => {
    const r = await post('/api/monitors/url/not-a-number/run', {});
    expect(r.status).toBe(400);
  });

  test('bad type → 400', async () => {
    const r = await post(`/api/monitors/bogus/${urlId}/run`, {});
    expect(r.status).toBe(400);
  });

  test('valid url monitor → 200 + executionId', async () => {
    const r = await post(`/api/monitors/url/${urlId}/run`, {});
    expect(r.status).toBe(200);
    const body = (await r.json()) as { executionId: number };
    expect(body.executionId).toBeGreaterThan(0);
  });
});
