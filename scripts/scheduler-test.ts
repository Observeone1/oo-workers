#!/usr/bin/env bun
/**
 * Scheduler test — insert monitors with a tight interval, wait, verify the
 * scheduler picks them up and creates execution rows automatically. No
 * manual BullMQ.add().
 *
 * The monitors point at a tiny local always-200 HTTP server stood up by
 * this script (mirrors the node:http catch-all in qa-alerting-test.ts) —
 * NOT an external host. This keeps the gate deterministic: every probe
 * is a localhost round-trip, so the strict `urlOk === urlN` assertion
 * stays meaningful (a real scheduler regression still fails it) without
 * the flake of depending on the public internet from a CI runner.
 *
 * The test deletes the monitors it creates in a finally block. It used
 * to leak them — enabled monitors the worker then reschedules forever,
 * saturating the worker and cross-contaminating later suite scripts.
 *
 * NOTE: this script and the worker MUST share a network namespace — the
 * worker's probe targets a 127.0.0.1 server living in *this* process.
 * `run-integration.sh` and CI satisfy this (sibling host processes). The
 * old `docker compose run --rm worker …` invocation does NOT (separate
 * container netns → worker can't reach the local server) and no longer
 * works; run it on the host alongside the worker instead:
 *   DATABASE_URL=… REDIS_URL=… bun scripts/scheduler-test.ts
 */

import { SQL } from 'bun';
import { createServer, type Server } from 'node:http';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://oo:oo@localhost:5432/oo_workers';
const sql = new SQL(DATABASE_URL);

const INTERVAL = 10; // seconds — tight so the test doesn't drag
const WAIT_TICKS = 3; // expect at least this many executions after WAIT_FOR_S

// Always-200 target. The worker is a sibling process on the same host,
// so 127.0.0.1 is reachable across processes (same pattern proven in
// qa-alerting-test.ts). Deterministic input → strict assertion stays honest.
const server: Server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
});

// Ids of the monitors this run created — hoisted so the finally block
// can delete them. The test used to leak these (enabled monitors the
// worker reschedules forever); self-cleanup keeps every run residue-free.
let createdUrlId: number | null = null;
let createdApiId: number | null = null;

async function main() {
  console.log('=== scheduler test ===');

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') {
    console.error('no server address');
    process.exit(1);
  }
  const targetUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`  local always-200 target at ${targetUrl}`);
  console.log(`  setting up monitors with interval=${INTERVAL}s`);

  const [urlMon] = await sql`
    INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
    VALUES ('sched-url', ${targetUrl}, 10000, ${INTERVAL}, TRUE)
    RETURNING *
  `;
  createdUrlId = urlMon.id;
  await sql`INSERT INTO url_monitor_assertions (url_monitor_id, operator, status_code) VALUES (${urlMon.id}, 'equals', 200)`;

  const [apiChk] = await sql`
    INSERT INTO api_checks (name, url, method, headers, timeout_ms, interval_seconds, enabled)
    VALUES ('sched-api', ${targetUrl}, 'GET', '{}'::jsonb, 10000, ${INTERVAL}, TRUE)
    RETURNING *
  `;
  createdApiId = apiChk.id;
  await sql`INSERT INTO api_assertions (api_check_id, type, operator, value) VALUES (${apiChk.id}, 'status_code', 'equals', '200')`;

  const waitFor = INTERVAL * WAIT_TICKS + 5;
  console.log(`  inserted url_monitor #${urlMon.id} and api_check #${apiChk.id}`);
  console.log(`  waiting ${waitFor}s for the scheduler to fire ~${WAIT_TICKS}× per monitor...`);

  await Bun.sleep(waitFor * 1000);

  const urlRuns = await sql`
    SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'SUCCESS') AS ok
    FROM url_monitor_executions WHERE url_monitor_id = ${urlMon.id}
  `;
  const apiRuns = await sql`
    SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE status = 'SUCCESS') AS ok
    FROM api_executions WHERE api_check_id = ${apiChk.id}
  `;

  const urlN = Number(urlRuns[0].n);
  const urlOk = Number(urlRuns[0].ok);
  const apiN = Number(apiRuns[0].n);
  const apiOk = Number(apiRuns[0].ok);

  console.log('');
  console.log(`  url-monitor: ${urlN} executions, ${urlOk} SUCCESS`);
  console.log(`  api-check:   ${apiN} executions, ${apiOk} SUCCESS`);

  const pass = urlN >= WAIT_TICKS - 1 && urlOk === urlN && apiN >= WAIT_TICKS - 1 && apiOk === apiN;
  console.log('');
  console.log(pass ? '✅ scheduler is firing on interval' : '❌ scheduler not firing as expected');

  return pass;
}

// Delete this run's monitors + their child rows. Explicit child deletes
// (no reliance on FK cascade), best-effort, so a teardown hiccup never
// flips the verdict. Without this the worker would reschedule the
// orphaned monitor forever.
async function cleanup() {
  try {
    if (createdUrlId != null) {
      await sql`DELETE FROM url_monitor_executions WHERE url_monitor_id = ${createdUrlId}`;
      await sql`DELETE FROM url_monitor_assertions WHERE url_monitor_id = ${createdUrlId}`;
      await sql`DELETE FROM url_monitors WHERE id = ${createdUrlId}`;
    }
    if (createdApiId != null) {
      await sql`DELETE FROM api_executions WHERE api_check_id = ${createdApiId}`;
      await sql`DELETE FROM api_assertions WHERE api_check_id = ${createdApiId}`;
      await sql`DELETE FROM api_checks WHERE id = ${createdApiId}`;
    }
  } catch (e) {
    console.error('  cleanup warning:', e instanceof Error ? e.message : e);
  }
}

let pass = false;
try {
  pass = await main();
} finally {
  await cleanup();
  await sql.end().catch(() => {});
  await new Promise<void>((r) => server.close(() => r()));
}
process.exit(pass ? 0 : 1);
