/**
 * Live-server gating test for surrogate-id remap (POST /api/import).
 * Ported from scripts/import-remap-test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { and, eq, inArray, like } from 'drizzle-orm';
import { acquireRedisDb, startTestServer } from './_harness.ts';
import { db } from '../../src/config/db.ts';
import { authService } from '../../src/services/auth.service.ts';
import { apiKeyRepo } from '../../src/db/repositories/api-key.repo.ts';
import { KEY_PREFIX_LEN } from '../../src/middleware/auth.ts';
import {
  alertChannels, apiChecks, apiKeys, monitorAlertChannels,
  statusPageMonitors, statusPages, urlMonitors, users, sessions,
} from '../../src/db/schema.ts';

const ts = Date.now();
const TAG = `remaptest-${ts}`;
const EMAIL = `remap+${ts}@local.test`;
const PW = 'Remappass123';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let auth: Record<string, string>;
let userId = -1;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;

  const u = await authService.register(EMAIL, PW, 'Remap Test');
  userId = u.id;
  const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
  await apiKeyRepo.create({ name: TAG, keyPrefix: cleartext.slice(0, KEY_PREFIX_LEN), keyHash, scopes: ['write'] });
  auth = { Authorization: `Bearer ${cleartext}`, 'content-type': 'application/json' };
}, 30_000);

afterAll(async () => {
  try {
    const sps = await db.select().from(statusPages).where(like(statusPages.slug, `${TAG}%`));
    if (sps.length > 0) {
      await db.delete(statusPageMonitors).where(inArray(statusPageMonitors.statusPageId, sps.map((s) => s.id)));
      await db.delete(statusPages).where(like(statusPages.slug, `${TAG}%`));
    }
    const urls = await db.select().from(urlMonitors).where(like(urlMonitors.name, `${TAG}%`));
    const apis = await db.select().from(apiChecks).where(like(apiChecks.name, `${TAG}%`));
    if (urls.length > 0) await db.delete(monitorAlertChannels).where(and(eq(monitorAlertChannels.monitorType, 'url'), inArray(monitorAlertChannels.monitorId, urls.map((u) => u.id))));
    if (apis.length > 0) await db.delete(monitorAlertChannels).where(and(eq(monitorAlertChannels.monitorType, 'api'), inArray(monitorAlertChannels.monitorId, apis.map((a) => a.id))));
    await db.delete(urlMonitors).where(like(urlMonitors.name, `${TAG}%`));
    await db.delete(apiChecks).where(like(apiChecks.name, `${TAG}%`));
    await db.delete(alertChannels).where(like(alertChannels.name, `${TAG}%`));
    await db.delete(apiKeys).where(eq(apiKeys.name, TAG));
    if (userId > 0) {
      await db.delete(sessions).where(eq(sessions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  } catch (e) { console.error('[import-remap cleanup]', e); }
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

describe('import-remap: POSITIVE — v1.25.0 bundle', () => {
  let posBody: { url: number; api: number; channels: number; channelBindings: number; statusPages: number; skipped: string[]; warnings: string[] };

  test('POST /api/import → 200', async () => {
    const res = await fetch(`${base}/api/import`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        version: 1,
        urlMonitors: [{ id: 100, name: `${TAG}-url-home`, url: 'https://example.com/home', timeoutMs: 5000, intervalSeconds: 60, enabled: true, assertions: [{ operator: 'equals', statusCode: 200 }], channelRefs: [10, 11] }],
        apiChecks: [{ id: 200, name: `${TAG}-api-health`, url: 'https://example.com/h', method: 'GET', headers: {}, body: null, timeoutMs: 5000, intervalSeconds: 60, enabled: true, assertions: [], channelRefs: [11] }],
        qaProjects: [],
        channels: [
          { id: 10, name: `${TAG}-ops`, type: 'email', config: { to: 'ops@example.com' } },
          { id: 11, name: `${TAG}-slack`, type: 'slack', config: { url: 'https://hooks.slack.com/aa' } },
        ],
        statusPages: [{ slug: `${TAG}-sp`, title: 'Remap status', description: null, monitors: [{ ref: 100, type: 'url' }, { ref: 200, type: 'api' }] }],
      }),
    });
    posBody = await res.json();
    expect(res.status).toBe(200);
  });

  test('1 url + 1 api + 2 channels + 1 statusPage created', () => {
    expect(posBody.url).toBe(1);
    expect(posBody.api).toBe(1);
    expect(posBody.channels).toBe(2);
    expect(posBody.statusPages).toBe(1);
  });

  test('channelBindings = 3 (url:2 + api:1)', () => expect(posBody.channelBindings).toBe(3));

  test('url monitor bound to both channels (surrogate refs resolved)', async () => {
    const urlMon = await db.select().from(urlMonitors).where(eq(urlMonitors.name, `${TAG}-url-home`));
    const emailCh = await db.select().from(alertChannels).where(eq(alertChannels.name, `${TAG}-ops`));
    const slackCh = await db.select().from(alertChannels).where(eq(alertChannels.name, `${TAG}-slack`));
    const bindings = await db.select().from(monitorAlertChannels).where(and(eq(monitorAlertChannels.monitorType, 'url'), eq(monitorAlertChannels.monitorId, urlMon[0].id)));
    const chIds = bindings.map((b) => b.channelId).sort();
    expect(chIds).toEqual([emailCh[0].id, slackCh[0].id].sort());
  });

  test('api check bound to slack only', async () => {
    const apiChk = await db.select().from(apiChecks).where(eq(apiChecks.name, `${TAG}-api-health`));
    const slackCh = await db.select().from(alertChannels).where(eq(alertChannels.name, `${TAG}-slack`));
    const bindings = await db.select().from(monitorAlertChannels).where(and(eq(monitorAlertChannels.monitorType, 'api'), eq(monitorAlertChannels.monitorId, apiChk[0].id)));
    expect(bindings.length).toBe(1);
    expect(bindings[0].channelId).toBe(slackCh[0].id);
  });

  test('status page created with both monitors bound', async () => {
    const sp = await db.select().from(statusPages).where(eq(statusPages.slug, `${TAG}-sp`));
    expect(sp.length).toBe(1);
    const urlMon = await db.select().from(urlMonitors).where(eq(urlMonitors.name, `${TAG}-url-home`));
    const apiChk = await db.select().from(apiChecks).where(eq(apiChecks.name, `${TAG}-api-health`));
    const bindings = await db.select().from(statusPageMonitors).where(eq(statusPageMonitors.statusPageId, sp[0].id));
    const pairs = bindings.map((b) => `${b.monitorType}:${b.monitorId}`).sort();
    expect(pairs).toEqual([`url:${urlMon[0].id}`, `api:${apiChk[0].id}`].sort());
  });
});

describe('import-remap: BACK-COMPAT — pre-1.25.0 bundle', () => {
  test('entities created, NO bindings, "no bindings" warning emitted', async () => {
    const res = await fetch(`${base}/api/import`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        version: 1,
        urlMonitors: [{ name: `${TAG}-bc-url`, url: 'https://example.com/bc', timeoutMs: 5000, intervalSeconds: 60, enabled: true, assertions: [{ operator: 'equals', statusCode: 200 }] }],
        apiChecks: [], qaProjects: [],
        channels: [{ name: `${TAG}-bc-email`, type: 'email', config: { to: 'bc@example.com' } }],
      }),
    });
    const body = await res.json() as { url: number; channels: number; channelBindings: number; warnings: string[] };
    expect(res.status).toBe(200);
    expect(body.url).toBe(1);
    expect(body.channels).toBe(1);
    expect(body.channelBindings).toBe(0);
    expect(body.warnings.some((w) => /no alert-channel bindings/i.test(w))).toBe(true);
  });
});

describe('import-remap: DANGLE — dangling refs', () => {
  test('dangling channel ref + dangling status page → skipped, monitor created', async () => {
    const res = await fetch(`${base}/api/import`, {
      method: 'POST', headers: auth,
      body: JSON.stringify({
        version: 1,
        urlMonitors: [{ id: 1, name: `${TAG}-d-url`, url: 'https://example.com/d', timeoutMs: 5000, intervalSeconds: 60, enabled: true, assertions: [{ operator: 'equals', statusCode: 200 }], channelRefs: [999] }],
        apiChecks: [], qaProjects: [], channels: [],
        statusPages: [{ slug: `${TAG}-d-sp`, title: 'Dangling', description: null, monitors: [{ ref: 999, type: 'url' }] }],
      }),
    });
    const body = await res.json() as { url: number; statusPages: number; channelBindings: number; skipped: string[] };
    expect(res.status).toBe(200);
    expect(body.url).toBe(1);
    expect(body.statusPages).toBe(0);
    expect(body.channelBindings).toBe(0);
    expect(body.skipped.some((s) => /channel ref 999/.test(s))).toBe(true);
    const dgSp = await db.select().from(statusPages).where(eq(statusPages.slug, `${TAG}-d-sp`));
    expect(dgSp.length).toBe(0);
  });
});
