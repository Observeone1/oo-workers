#!/usr/bin/env bun
/**
 * Scheduler test — insert monitors with a tight interval, wait, verify the
 * scheduler picks them up and creates execution rows automatically. No
 * manual BullMQ.add().
 *
 * Run from inside compose (so it can reach postgres / redis on the network):
 *   docker compose run --rm \
 *     -e DATABASE_URL=postgres://oo:oo@postgres:5432/oo_workers \
 *     -e REDIS_URL=redis://redis:6379 \
 *     --entrypoint "" worker bun scripts/scheduler-test.ts
 */

import { SQL } from 'bun';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://oo:oo@localhost:5432/oo_workers';
const sql = new SQL(DATABASE_URL);

const INTERVAL = 10;     // seconds — tight so the test doesn't drag
const WAIT_TICKS = 3;    // expect at least this many executions after WAIT_FOR_S

async function main() {
  console.log('=== scheduler test ===');
  console.log(`  setting up monitors with interval=${INTERVAL}s`);

  const [urlMon] = await sql`
    INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
    VALUES ('sched-url', 'https://example.com', 10000, ${INTERVAL}, TRUE)
    RETURNING *
  `;
  await sql`INSERT INTO url_monitor_assertions (url_monitor_id, operator, status_code) VALUES (${urlMon.id}, 'equals', 200)`;

  const [apiChk] = await sql`
    INSERT INTO api_checks (name, url, method, headers, timeout_ms, interval_seconds, enabled)
    VALUES ('sched-api', 'https://example.com', 'GET', '{}'::jsonb, 10000, ${INTERVAL}, TRUE)
    RETURNING *
  `;
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

  await sql.end();
  process.exit(pass ? 0 : 1);
}

await main();
