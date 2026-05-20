#!/usr/bin/env bun
/**
 * Live-server gating test for the surrogate-id remap (Roadmap 3.3).
 *
 * What this gates that the pure adapter test cannot: that POST /api/import
 * actually WIRES channel bindings and status-page→monitor attachments
 * using the bundle-local `id` fields (CLI v1.25.0+). The adapter is pure
 * and just shapes the payload — only this script exercises the server's
 * two-pass create-then-bind logic against a real Postgres.
 *
 * Anti-vacuous BY CONSTRUCTION via three cases on the same boot:
 *   POSITIVE: a v1.25.0 bundle (id + channelRefs + statusPages) imports →
 *     monitor_alert_channels rows + status_page_monitors rows exist with
 *     the EXPECTED real ids. A no-op handler that "just creates entities"
 *     would FAIL this — zero binding rows.
 *   BACK-COMPAT: a pre-1.25.0 bundle (no id fields anywhere) imports →
 *     entities created, ZERO binding rows, the "imported with no bindings"
 *     warning still fires. A handler that always wires bindings would
 *     FAIL this — either crash on missing refs or fabricate.
 *   DANGLE: a v1.25.0 bundle whose statusPages refs a non-existent
 *     surrogate id → no status page row created, skip note emitted.
 *
 * Needs Postgres + Redis (startServer wires BullMQ). Mutates the
 * integration DB with name-prefixed throwaway rows, deleted in finally.
 * Run: `bun scripts/import-remap-test.ts`. Also a stage in
 * scripts/run-integration.sh.
 */

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { and, eq, inArray, like } from 'drizzle-orm';
import { startServer } from '../src/server.ts';
import { authService } from '../src/services/auth.service.ts';
import { apiKeyRepo } from '../src/db/repositories/api-key.repo.ts';
import { KEY_PREFIX_LEN } from '../src/middleware/auth.ts';
import { db } from '../src/config/db.ts';
import {
  alertChannels,
  apiChecks,
  apiKeys,
  monitorAlertChannels,
  statusPageMonitors,
  statusPages,
  urlMonitors,
  users,
  sessions,
} from '../src/db/schema.ts';

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const ts = Date.now();
const TAG = `remaptest-${ts}`; // prefix for all rows so cleanup is trivial
const EMAIL = `remap+${ts}@local.test`;
const PW = 'Remappass123';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

let stopServer: (() => Promise<void>) | null = null;
let userId = -1;

try {
  const port = await freePort();
  stopServer = startServer(connection, port);
  const base = `http://127.0.0.1:${port}`;

  // Real user + write-scope API key. /api/import is gated by requireAuth
  // (writeAuth specifically) — the bearer header must work end-to-end.
  // Mirrors scripts/create-api-key.ts: 32 random bytes → cleartext +
  // argon2id hash + prefix-stored alongside.
  const u = await authService.register(EMAIL, PW, 'Remap Test');
  userId = u.id;
  const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
  await apiKeyRepo.create({
    name: TAG,
    keyPrefix: cleartext.slice(0, KEY_PREFIX_LEN),
    keyHash,
    scopes: ['write'],
  });
  const auth = { Authorization: `Bearer ${cleartext}`, 'content-type': 'application/json' };

  await new Promise((r) => setTimeout(r, 300));

  // ---------------- POSITIVE: v1.25.0 bundle ----------------
  // 2 monitors, 2 channels, 1 status page. Monitor 100 binds channels
  // [10,11]; api-check 200 binds [11]; status page binds both monitors.
  const positivePayload = {
    version: 1,
    urlMonitors: [
      {
        id: 100,
        name: `${TAG}-url-home`,
        url: 'https://example.com/home',
        timeoutMs: 5000,
        intervalSeconds: 60,
        enabled: true,
        assertions: [{ operator: 'equals', statusCode: 200 }],
        channelRefs: [10, 11],
      },
    ],
    apiChecks: [
      {
        id: 200,
        name: `${TAG}-api-health`,
        url: 'https://example.com/h',
        method: 'GET',
        headers: {},
        body: null,
        timeoutMs: 5000,
        intervalSeconds: 60,
        enabled: true,
        assertions: [],
        channelRefs: [11],
      },
    ],
    qaProjects: [],
    channels: [
      { id: 10, name: `${TAG}-ops`, type: 'email', config: { to: 'ops@example.com' } },
      {
        id: 11,
        name: `${TAG}-slack`,
        type: 'slack',
        config: { url: 'https://hooks.slack.com/aa' },
      },
    ],
    statusPages: [
      {
        slug: `${TAG}-sp`,
        title: 'Remap status',
        description: null,
        monitors: [
          { ref: 100, type: 'url' },
          { ref: 200, type: 'api' },
        ],
      },
    ],
  };

  const posRes = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(positivePayload),
  });
  const posBody = (await posRes.json()) as {
    url: number;
    api: number;
    channels: number;
    channelBindings: number;
    statusPages: number;
    skipped: string[];
    warnings: string[];
  };
  check('POS. /api/import → 200', posRes.status === 200, JSON.stringify(posBody));
  check(
    'POS. 1 url + 1 api + 2 channels + 1 statusPage created',
    posBody.url === 1 && posBody.api === 1 && posBody.channels === 2 && posBody.statusPages === 1,
    JSON.stringify(posBody),
  );
  check(
    'POS. channelBindings count = 3 (url:2 + api:1)',
    posBody.channelBindings === 3,
    JSON.stringify(posBody),
  );

  // DB readback — bindings exist for the right (monitor, channel) pairs.
  const urlMonitor = await db
    .select()
    .from(urlMonitors)
    .where(eq(urlMonitors.name, `${TAG}-url-home`));
  const apiCheck = await db
    .select()
    .from(apiChecks)
    .where(eq(apiChecks.name, `${TAG}-api-health`));
  const emailCh = await db
    .select()
    .from(alertChannels)
    .where(eq(alertChannels.name, `${TAG}-ops`));
  const slackCh = await db
    .select()
    .from(alertChannels)
    .where(eq(alertChannels.name, `${TAG}-slack`));
  check(
    'POS. all entities readable in DB',
    urlMonitor.length === 1 &&
      apiCheck.length === 1 &&
      emailCh.length === 1 &&
      slackCh.length === 1,
    JSON.stringify({ urlMonitor, apiCheck, emailCh, slackCh }),
  );

  const urlBindings = await db
    .select()
    .from(monitorAlertChannels)
    .where(
      and(
        eq(monitorAlertChannels.monitorType, 'url'),
        eq(monitorAlertChannels.monitorId, urlMonitor[0].id),
      ),
    );
  const urlChIds = urlBindings.map((b) => b.channelId).sort();
  const expectedUrlChIds = [emailCh[0].id, slackCh[0].id].sort();
  check(
    'POS. url monitor bound to both channels (surrogate refs resolved)',
    JSON.stringify(urlChIds) === JSON.stringify(expectedUrlChIds),
    `got=${JSON.stringify(urlChIds)} expected=${JSON.stringify(expectedUrlChIds)}`,
  );

  const apiBindings = await db
    .select()
    .from(monitorAlertChannels)
    .where(
      and(
        eq(monitorAlertChannels.monitorType, 'api'),
        eq(monitorAlertChannels.monitorId, apiCheck[0].id),
      ),
    );
  check(
    'POS. api check bound to slack only (surrogate ref 11 → real id)',
    apiBindings.length === 1 && apiBindings[0].channelId === slackCh[0].id,
    JSON.stringify(apiBindings),
  );

  const sp = await db
    .select()
    .from(statusPages)
    .where(eq(statusPages.slug, `${TAG}-sp`));
  check('POS. status page created', sp.length === 1, JSON.stringify(sp));
  const spBindings = await db
    .select()
    .from(statusPageMonitors)
    .where(eq(statusPageMonitors.statusPageId, sp[0].id));
  const spPairs = spBindings.map((b) => `${b.monitorType}:${b.monitorId}`).sort();
  const expectedSpPairs = [`url:${urlMonitor[0].id}`, `api:${apiCheck[0].id}`].sort();
  check(
    'POS. status page bound to both monitors (refs resolved)',
    JSON.stringify(spPairs) === JSON.stringify(expectedSpPairs),
    `got=${JSON.stringify(spPairs)} expected=${JSON.stringify(expectedSpPairs)}`,
  );

  // No "imported with no bindings" warning when bindings did wire through.
  check(
    'POS. no "no bindings" warning when bindings exist',
    !posBody.warnings.some((w) => /no alert-channel bindings/i.test(w)),
    JSON.stringify(posBody.warnings),
  );

  // ---------------- BACK-COMPAT: pre-1.25.0 bundle (no ids) ----------------
  const backCompatPayload = {
    version: 1,
    urlMonitors: [
      {
        name: `${TAG}-bc-url`,
        url: 'https://example.com/bc',
        timeoutMs: 5000,
        intervalSeconds: 60,
        enabled: true,
        assertions: [{ operator: 'equals', statusCode: 200 }],
      },
    ],
    apiChecks: [],
    qaProjects: [],
    channels: [{ name: `${TAG}-bc-email`, type: 'email', config: { to: 'bc@example.com' } }],
  };
  const bcRes = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(backCompatPayload),
  });
  const bcBody = (await bcRes.json()) as {
    url: number;
    channels: number;
    channelBindings: number;
    warnings: string[];
  };
  check('BC. /api/import → 200', bcRes.status === 200, JSON.stringify(bcBody));
  check(
    'BC. entities created, NO bindings (no surrogate ids to resolve)',
    bcBody.url === 1 && bcBody.channels === 1 && bcBody.channelBindings === 0,
    JSON.stringify(bcBody),
  );
  // The legacy "no bindings — go bind them" warning must fire so a
  // pre-1.25.0 user isn't left flying blind. Anti-vacuous: a handler
  // that ALWAYS wires bindings would have channelBindings > 0 here.
  check(
    'BC. "no bindings" warning is emitted (legacy nudge preserved)',
    bcBody.warnings.some((w) => /no alert-channel bindings/i.test(w)),
    JSON.stringify(bcBody.warnings),
  );

  // ---------------- DANGLE: ref points at non-existent surrogate id -----
  const danglePayload = {
    version: 1,
    urlMonitors: [
      {
        id: 1,
        name: `${TAG}-d-url`,
        url: 'https://example.com/d',
        timeoutMs: 5000,
        intervalSeconds: 60,
        enabled: true,
        assertions: [{ operator: 'equals', statusCode: 200 }],
        // refers to a channel surrogate id 999 that doesn't exist in
        // this bundle — must skip + report, not crash, not fabricate.
        channelRefs: [999],
      },
    ],
    apiChecks: [],
    qaProjects: [],
    channels: [],
    statusPages: [
      {
        slug: `${TAG}-d-sp`,
        title: 'Dangling',
        description: null,
        // refers to monitor surrogate id 999 (doesn't exist) — page
        // must NOT be created (all refs dangle), skipped instead.
        monitors: [{ ref: 999, type: 'url' as const }],
      },
    ],
  };
  const dgRes = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(danglePayload),
  });
  const dgBody = (await dgRes.json()) as {
    url: number;
    statusPages: number;
    channelBindings: number;
    skipped: string[];
  };
  check('DG. /api/import → 200', dgRes.status === 200, JSON.stringify(dgBody));
  check(
    'DG. monitor created, no bindings, no page (all refs dangled)',
    dgBody.url === 1 && dgBody.statusPages === 0 && dgBody.channelBindings === 0,
    JSON.stringify(dgBody),
  );
  check(
    'DG. dangling channel ref surfaced in skipped',
    dgBody.skipped.some((s) => /channel ref 999/.test(s)),
    JSON.stringify(dgBody.skipped),
  );
  check(
    'DG. dangling status page surfaced in skipped',
    dgBody.skipped.some((s) => /all monitor refs dangling|ref 999/.test(s)),
    JSON.stringify(dgBody.skipped),
  );
  const dgSp = await db
    .select()
    .from(statusPages)
    .where(eq(statusPages.slug, `${TAG}-d-sp`));
  check('DG. dangling status page NOT created in DB', dgSp.length === 0, JSON.stringify(dgSp));
} finally {
  // Cleanup — prefix-targeted so we never touch unrelated rows.
  try {
    const sps = await db
      .select()
      .from(statusPages)
      .where(like(statusPages.slug, `${TAG}%`));
    if (sps.length > 0) {
      await db.delete(statusPageMonitors).where(
        inArray(
          statusPageMonitors.statusPageId,
          sps.map((s) => s.id),
        ),
      );
      await db.delete(statusPages).where(like(statusPages.slug, `${TAG}%`));
    }
    const urls = await db
      .select()
      .from(urlMonitors)
      .where(like(urlMonitors.name, `${TAG}%`));
    const apis = await db
      .select()
      .from(apiChecks)
      .where(like(apiChecks.name, `${TAG}%`));
    if (urls.length > 0) {
      await db.delete(monitorAlertChannels).where(
        and(
          eq(monitorAlertChannels.monitorType, 'url'),
          inArray(
            monitorAlertChannels.monitorId,
            urls.map((u) => u.id),
          ),
        ),
      );
    }
    if (apis.length > 0) {
      await db.delete(monitorAlertChannels).where(
        and(
          eq(monitorAlertChannels.monitorType, 'api'),
          inArray(
            monitorAlertChannels.monitorId,
            apis.map((a) => a.id),
          ),
        ),
      );
    }
    await db.delete(urlMonitors).where(like(urlMonitors.name, `${TAG}%`));
    await db.delete(apiChecks).where(like(apiChecks.name, `${TAG}%`));
    await db.delete(alertChannels).where(like(alertChannels.name, `${TAG}%`));
    await db.delete(apiKeys).where(eq(apiKeys.name, TAG));
    if (userId > 0) {
      await db.delete(sessions).where(eq(sessions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  } catch (cleanupErr) {
    console.error(
      `[import-remap-test] cleanup error (ignored): ${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`,
    );
  }
  if (stopServer) await stopServer().catch(() => {});
  connection.disconnect();
}

console.log(failed ? '\n❌ import-remap-test FAILED' : '\n✅ import-remap-test passed');
process.exit(failed ? 1 : 0);
