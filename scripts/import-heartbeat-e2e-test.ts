#!/usr/bin/env bun
/**
 * Live-server gating test for SaaS→self-host heartbeat import.
 *
 * The /api/import path lets oo-workers ingest a CLI-shaped SaaS export.
 * As of CLI v1.26.0 + oo-workers v1.22.0, each heartbeat carries a
 * `ping_key` that the import re-uses as the self-host token, preserving
 * the public ping URL across migration. This test exercises the full
 * path end-to-end:
 *
 *   POST /api/import {heartbeats:[{...,token}]} → 200, row created
 *   GET  /api/monitors                          → row present with the
 *                                                 supplied token
 *   POST /heartbeat/<supplied-token>            → 200, status flips UP
 *   POST /api/import {heartbeats:[{... no token}]} → row created with a
 *                                                 freshly-generated token
 *                                                 (proves the default
 *                                                 path is unchanged)
 *
 * Anti-vacuous BY CONSTRUCTION: a handler that ignores the supplied
 * token and always generates a fresh one FAILS the token-preservation
 * check; a handler that fails to flip status FAILS the ping check; a
 * handler that pins to a hardcoded token FAILS the negative control.
 *
 * Run: `bun scripts/import-heartbeat-e2e-test.ts`.
 * Also a stage in run-integration.sh.
 */

import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq, like } from 'drizzle-orm';
import { startServer } from '../src/server.ts';
import { authService } from '../src/services/auth.service.ts';
import { apiKeyRepo } from '../src/db/repositories/api-key.repo.ts';
import { KEY_PREFIX_LEN } from '../src/middleware/auth.ts';
import { db } from '../src/config/db.ts';
import { heartbeatMonitors, users, sessions, apiKeys } from '../src/db/schema.ts';

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
const TAG = `hbimport-${ts}`;
const EMAIL = `hbimport+${ts}@local.test`;
const PW = 'Hbpass123';
const FIXED_TOKEN = `e2e-import-token-${randomBytes(8).toString('hex')}`;

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

let stopServer: (() => Promise<void>) | null = null;
let userId = -1;

try {
  const port = await freePort();
  stopServer = startServer(connection, port);
  const base = `http://127.0.0.1:${port}`;

  // Bootstrap an account + API key, same pattern as heartbeat-test.ts.
  const u = await authService.register(EMAIL, PW, 'Heartbeat Import Test');
  userId = u.id;
  const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
  const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
  await apiKeyRepo.create({
    name: TAG,
    keyPrefix: cleartext.slice(0, KEY_PREFIX_LEN),
    keyHash,
    scopes: ['write'],
  });
  const writeHdr = { Authorization: `Bearer ${cleartext}`, 'content-type': 'application/json' };

  await new Promise((r) => setTimeout(r, 300));

  // ---- A: import a heartbeat WITH ping_key (token) → preserved ----
  const nameKept = `${TAG}-kept`;
  const importRes = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: writeHdr,
    body: JSON.stringify({
      version: 1,
      urlMonitors: [],
      apiChecks: [],
      qaProjects: [],
      channels: [],
      heartbeats: [
        {
          name: nameKept,
          description: 'imported with ping_key',
          periodSeconds: 120,
          graceSeconds: 30,
          token: FIXED_TOKEN,
        },
      ],
    }),
  });
  const importBody = (await importRes.json()) as { heartbeat?: number; skipped?: string[] };
  check('A. POST /api/import → 200', importRes.status === 200, JSON.stringify(importBody));
  check(
    'A. response.created.heartbeat === 1',
    importBody.heartbeat === 1,
    JSON.stringify(importBody),
  );
  check(
    'A. no per-item skip on a well-formed heartbeat',
    (importBody.skipped ?? []).length === 0,
    JSON.stringify(importBody.skipped),
  );

  // ---- B: row exists with the SUPPLIED token (this is the headline) ----
  const listRes = await fetch(`${base}/api/monitors`, { headers: writeHdr });
  const listBody = (await listRes.json()) as {
    heartbeat: Array<{ id: number; name: string; token: string; status: string }>;
  };
  const kept = listBody.heartbeat.find((h) => h.name === nameKept);
  check('B. imported row visible in /api/monitors', kept !== undefined, JSON.stringify(kept));
  check(
    'B. token is the SAME value as the SaaS ping_key (preserves URL)',
    kept?.token === FIXED_TOKEN,
    `expected=${FIXED_TOKEN} got=${kept?.token}`,
  );
  check('B. status starts PENDING (no ping yet)', kept?.status === 'PENDING');

  // ---- C: ping the public URL — the actual user-visible benefit ----
  const pingRes = await fetch(`${base}/heartbeat/${FIXED_TOKEN}`, { method: 'POST' });
  const pingBody = (await pingRes.json()) as { ok: boolean; status: string };
  check(
    'C. POST /heartbeat/<preserved-token> → 200',
    pingRes.status === 200,
    JSON.stringify(pingBody),
  );
  check('C. ping flipped status PENDING → UP', pingBody.status === 'UP', JSON.stringify(pingBody));

  // ---- D: negative control — import WITHOUT a token → fresh token ----
  // Proves the import doesn't always re-use FIXED_TOKEN (which would be
  // a vacuous pass for the previous check) and doesn't hardcode any one
  // string. A handler that pins to the supplied token regardless would
  // create a collision here and the second row would error out OR get a
  // duplicate token, both of which fail subsequent assertions.
  const nameFresh = `${TAG}-fresh`;
  const freshRes = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: writeHdr,
    body: JSON.stringify({
      version: 1,
      urlMonitors: [],
      apiChecks: [],
      qaProjects: [],
      channels: [],
      heartbeats: [
        { name: nameFresh, periodSeconds: 60, graceSeconds: 30 }, // no token field
      ],
    }),
  });
  check('D. import without token → 200', freshRes.status === 200);
  const list2 = (await (await fetch(`${base}/api/monitors`, { headers: writeHdr })).json()) as {
    heartbeat: Array<{ name: string; token: string }>;
  };
  const fresh = list2.heartbeat.find((h) => h.name === nameFresh);
  check('D. row created', fresh !== undefined, JSON.stringify(fresh));
  check(
    'D. token is freshly generated (not equal to FIXED_TOKEN, base64url ≥ 40 chars)',
    fresh !== undefined &&
      fresh.token !== FIXED_TOKEN &&
      fresh.token.length >= 40 &&
      /^[A-Za-z0-9_-]+$/.test(fresh.token),
    JSON.stringify(fresh),
  );

  // ---- E: validation — invalid period gets skipped, not silently created ----
  // Server-side guard at /api/import mirrors POST /api/monitors/heartbeat.
  // A handler that bypasses validation would create a sub-30s heartbeat.
  const nameBad = `${TAG}-bad`;
  const badRes = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: writeHdr,
    body: JSON.stringify({
      version: 1,
      urlMonitors: [],
      apiChecks: [],
      qaProjects: [],
      channels: [],
      heartbeats: [{ name: nameBad, periodSeconds: 5, graceSeconds: 30 }],
    }),
  });
  const badBody = (await badRes.json()) as { heartbeat?: number; skipped?: string[] };
  check(
    'E. period < 30 → skipped on the server, heartbeat count stays 0',
    badBody.heartbeat === 0 && (badBody.skipped ?? []).some((s) => s.includes(nameBad)),
    JSON.stringify(badBody),
  );
  const list3 = (await (await fetch(`${base}/api/monitors`, { headers: writeHdr })).json()) as {
    heartbeat: Array<{ name: string }>;
  };
  check(
    'E. no row created for the invalid heartbeat',
    list3.heartbeat.find((h) => h.name === nameBad) === undefined,
  );
} finally {
  try {
    // Cleanup: everything we tagged.
    await db.delete(heartbeatMonitors).where(like(heartbeatMonitors.name, `${TAG}%`));
    await db.delete(apiKeys).where(eq(apiKeys.name, TAG));
    if (userId > 0) {
      await db.delete(sessions).where(eq(sessions.userId, userId));
      await db.delete(users).where(eq(users.id, userId));
    }
  } catch {
    /* ignore cleanup errors */
  }
  if (stopServer) await stopServer().catch(() => {});
  connection.disconnect();
}

console.log(
  failed ? '\n❌ import-heartbeat-e2e-test FAILED' : '\n✅ import-heartbeat-e2e-test passed',
);
process.exit(failed ? 1 : 0);
