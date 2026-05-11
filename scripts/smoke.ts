#!/usr/bin/env bun
/**
 * Smoke test: HTTP + API monitor end-to-end.
 *
 * Inserts a monitor row + pending execution row in Postgres,
 * pushes a BullMQ job, then polls Postgres for the execution to flip to SUCCESS.
 *
 * Usage:
 *   DATABASE_URL=... REDIS_URL=... bun scripts/smoke.ts
 *
 * Or against the running docker-compose stack:
 *   DATABASE_URL="postgres://oo:oo@localhost:5432/oo_workers" \
 *   REDIS_URL="redis://localhost:6379" \
 *   bun scripts/smoke.ts
 */

import { SQL } from 'bun';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://oo:oo@localhost:5432/oo_workers';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const sql = new SQL(DATABASE_URL);
const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

async function pollUntilDone(execId: number, table: 'url_monitor_executions' | 'api_executions', timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await sql.unsafe(`SELECT * FROM ${table} WHERE id = $1`, [execId]);
    const row = rows[0];
    if (row && row.status !== 'pending') return row;
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${table} #${execId}`);
}

// ---- url-monitor smoke ----
async function smokeUrlMonitor() {
  console.log('\n=== url-monitor smoke ===');
  const [monitor] = await sql`
    INSERT INTO url_monitors (name, url, timeout_ms)
    VALUES ('smoke-example', 'https://example.com', 10000)
    RETURNING *
  `;
  console.log(`  monitor #${monitor.id} created (${monitor.url})`);

  const [assertion] = await sql`
    INSERT INTO url_monitor_assertions (url_monitor_id, operator, status_code)
    VALUES (${monitor.id}, 'equals', 200)
    RETURNING *
  `;

  const [exec] = await sql`
    INSERT INTO url_monitor_executions (url_monitor_id, status)
    VALUES (${monitor.id}, 'pending')
    RETURNING *
  `;
  console.log(`  execution #${exec.id} created (pending)`);

  const queue = new Queue('url-monitor', { connection });
  const job = await queue.add('check', {
    executionId: exec.id,
    monitor: { id: monitor.id, url: monitor.url, timeout_ms: monitor.timeout_ms },
    assertions: [{ id: assertion.id, operator: 'equals', status_code: 200 }],
  });
  console.log(`  job ${job.id} pushed → waiting for worker...`);

  const result = await pollUntilDone(exec.id, 'url_monitor_executions');
  console.log(`  ✅ result: status=${result.status}, http=${result.status_code}, ${result.response_time_ms}ms`);
  await queue.close();
  return result.status === 'SUCCESS';
}

// ---- api-check smoke ----
async function smokeApiCheck() {
  console.log('\n=== api-check smoke ===');
  const [check] = await sql`
    INSERT INTO api_checks (name, url, method, headers, timeout_ms)
    VALUES ('smoke-example', 'https://example.com', 'GET', '{}'::jsonb, 10000)
    RETURNING *
  `;
  console.log(`  api_check #${check.id} created (${check.url})`);

  const [assertion] = await sql`
    INSERT INTO api_assertions (api_check_id, type, operator, path, value)
    VALUES (${check.id}, 'status_code', 'equals', NULL, '200')
    RETURNING *
  `;

  const [exec] = await sql`
    INSERT INTO api_executions (api_check_id, status)
    VALUES (${check.id}, 'pending')
    RETURNING *
  `;
  console.log(`  execution #${exec.id} created (pending)`);

  const queue = new Queue('api-check', { connection });
  const job = await queue.add('check', {
    executionId: exec.id,
    apiCheck: {
      id: check.id,
      url: check.url,
      method: check.method,
      headers: check.headers,
      timeout_ms: check.timeout_ms,
    },
    assertions: [{ id: assertion.id, type: 'status_code', operator: 'equals', path: null, value: '200' }],
  });
  console.log(`  job ${job.id} pushed → waiting for worker...`);

  const result = await pollUntilDone(exec.id, 'api_executions');
  console.log(`  ✅ result: status=${result.status}, http=${result.response_status}, ${result.response_time_ms}ms`);
  await queue.close();
  return result.status === 'SUCCESS';
}

// ---- qa-project (browser) smoke ----
async function smokeQaProject() {
  console.log('\n=== qa-project (browser) smoke ===');

  const [project] = await sql`
    INSERT INTO qa_projects (name, target_url, status)
    VALUES ('smoke-browser', 'https://example.com', 'active')
    RETURNING *
  `;
  console.log(`  qa_project #${project.id} created`);

  const script = `
import { test, expect } from '@playwright/test';

test('smoke loads example.com', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page.locator('h1')).toBeVisible();
  await expect(page.locator('h1')).toHaveText('Example Domain');
});
`.trim();

  const [genTest] = await sql`
    INSERT INTO qa_generated_tests (project_id, test_name, test_type, script, description)
    VALUES (${project.id}, 'smoke-loads-example', 'browser', ${script}, 'smoke')
    RETURNING *
  `;
  console.log(`  qa_generated_test #${genTest.id} created (script: ${script.length} chars inline)`);

  const queue = new Queue('qa-project', { connection });
  const job = await queue.add('run', {
    type: 'qa-project-run',
    project_id: project.id,
    target_url: project.target_url,
    config: { timeout: 30_000 },
    tests: [{ id: genTest.id, name: genTest.test_name, script }],
    triggered_at: new Date().toISOString(),
  });
  console.log(`  job ${job.id} pushed → waiting for worker (Playwright can take 10-30s)...`);

  // poll qa_test_executions for this project
  const start = Date.now();
  while (Date.now() - start < 90_000) {
    const rows = await sql`
      SELECT * FROM qa_test_executions WHERE project_id = ${project.id} ORDER BY id DESC LIMIT 1
    `;
    const row = rows[0];
    if (row && row.status !== 'running') {
      console.log(`  ✅ result: status=${row.status}, duration=${row.duration_ms}ms`);
      if (row.error_message) console.log(`     error: ${row.error_message.slice(0, 200)}`);
      await queue.close();
      return row.status === 'passed';
    }
    await Bun.sleep(1000);
  }
  await queue.close();
  console.log('  ❌ timed out after 90s');
  return false;
}

const urlOk = await smokeUrlMonitor();
const apiOk = await smokeApiCheck();
const qaOk = await smokeQaProject();

console.log('\n=== summary ===');
console.log(`  url-monitor: ${urlOk ? '✅' : '❌'}`);
console.log(`  api-check:   ${apiOk ? '✅' : '❌'}`);
console.log(`  qa-project:  ${qaOk ? '✅' : '❌'}`);

await sql.end();
await connection.quit();
process.exit(urlOk && apiOk && qaOk ? 0 : 1);
