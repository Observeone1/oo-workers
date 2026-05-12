#!/usr/bin/env bun
/**
 * Load + edge-case test for oo-workers.
 *
 * Exercises:
 *   1. Concurrency burst   — 30 url-monitor jobs in parallel
 *   2. Failure modes        — DNS failure, timeout, wrong-status assertion
 *   3. Assertion variety    — status / time / text / header in one api-check
 *   4. JSON-path assertion  — real JSON endpoint with json_path operator
 *   5. Browser parallelism  — 3 qa-project jobs running side-by-side
 *
 * Usage (against running compose stack):
 *   docker compose run --rm \
 *     -e DATABASE_URL=postgres://oo:oo@postgres:5432/oo_workers \
 *     -e REDIS_URL=redis://redis:6379 \
 *     --entrypoint "" worker bun scripts/load.ts
 */

import { SQL } from 'bun';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://oo:oo@localhost:5432/oo_workers';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const sql = new SQL(DATABASE_URL);
const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });

const urlQ = new Queue('url-monitor', { connection });
const apiQ = new Queue('api-check', { connection });
const qaQ = new Queue('qa-project', { connection });

const results: Record<string, { passed: number; failed: number; details: string[] }> = {};

function record(scenario: string, passed: boolean, detail: string) {
  if (!results[scenario]) results[scenario] = { passed: 0, failed: 0, details: [] };
  if (passed) results[scenario].passed++;
  else results[scenario].failed++;
  results[scenario].details.push(`${passed ? '✅' : '❌'} ${detail}`);
}

async function waitFor<T>(getFn: () => Promise<T | null>, timeoutMs: number): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await getFn();
    if (v) return v;
    await Bun.sleep(300);
  }
  return null;
}

// ============================================================
// 1. Concurrency burst — 30 url-monitor jobs in parallel
// ============================================================
async function concurrencyBurst() {
  console.log('\n=== 1. Concurrency burst: 30 url-monitor jobs in parallel ===');
  const N = 30;

  // Create one monitor, push N executions through it
  const [monitor] = await sql`
    INSERT INTO url_monitors (name, url, timeout_ms)
    VALUES ('burst-target', 'https://example.com', 10000)
    RETURNING *
  `;

  const execs: number[] = [];
  for (let i = 0; i < N; i++) {
    const [e] = await sql`
      INSERT INTO url_monitor_executions (url_monitor_id, status)
      VALUES (${monitor.id}, 'PENDING')
      RETURNING id
    `;
    execs.push(e.id);
  }

  const t0 = Date.now();
  await Promise.all(
    execs.map((execId) =>
      urlQ.add('check', {
        executionId: execId,
        monitor: { id: monitor.id, url: monitor.url, timeoutMs: monitor.timeout_ms },
        assertions: [],
      }),
    ),
  );
  console.log(`  pushed ${N} jobs at t+0ms`);

  const done = await waitFor(async () => {
    const rows = await sql`
      SELECT COUNT(*) FILTER (WHERE status != 'PENDING') AS done
      FROM url_monitor_executions
      WHERE url_monitor_id = ${monitor.id}
    `;
    return Number(rows[0].done) === N ? rows : null;
  }, 60_000);

  const t = Date.now() - t0;
  if (!done) {
    record('concurrency-burst', false, `only some of ${N} jobs finished within 60s`);
    return;
  }

  const stats = await sql`
    SELECT status, COUNT(*) AS n, AVG(response_time_ms)::int AS avg_ms
    FROM url_monitor_executions
    WHERE url_monitor_id = ${monitor.id}
    GROUP BY status
  `;
  const success = Number(stats.find((s: any) => s.status === 'SUCCESS')?.n ?? 0);
  console.log(`  ${N} jobs done in ${t}ms. success=${success}, avg=${stats[0]?.avg_ms}ms`);
  record('concurrency-burst', success === N, `${success}/${N} SUCCESS in ${t}ms`);
}

// ============================================================
// 2. Failure modes
// ============================================================
async function failureModes() {
  console.log('\n=== 2. Failure modes ===');

  // 2a. DNS failure
  const [dnsMon] = await sql`
    INSERT INTO url_monitors (name, url, timeout_ms)
    VALUES ('dns-fail', 'https://this-host-does-not-exist-xyz-12345.invalid', 5000)
    RETURNING *
  `;
  const [dnsExec] =
    await sql`INSERT INTO url_monitor_executions (url_monitor_id, status) VALUES (${dnsMon.id}, 'PENDING') RETURNING id`;
  await urlQ.add('check', {
    executionId: dnsExec.id,
    monitor: { id: dnsMon.id, url: dnsMon.url, timeoutMs: dnsMon.timeout_ms },
    assertions: [],
  });

  // 2b. Timeout (very short timeout to a known-slow endpoint isn't reliable;
  // instead point at an unroutable IP that will timeout)
  const [toMon] = await sql`
    INSERT INTO url_monitors (name, url, timeout_ms)
    VALUES ('timeout', 'http://10.255.255.1', 2000)
    RETURNING *
  `;
  const [toExec] =
    await sql`INSERT INTO url_monitor_executions (url_monitor_id, status) VALUES (${toMon.id}, 'PENDING') RETURNING id`;
  await urlQ.add('check', {
    executionId: toExec.id,
    monitor: { id: toMon.id, url: toMon.url, timeoutMs: toMon.timeout_ms },
    assertions: [],
  });

  // 2c. Wrong-status assertion (asks for 200, gets 200, but assertion says expect 404)
  const [wrongMon] = await sql`
    INSERT INTO url_monitors (name, url, timeout_ms)
    VALUES ('wrong-status-assert', 'https://example.com', 5000)
    RETURNING *
  `;
  const [wrongExec] =
    await sql`INSERT INTO url_monitor_executions (url_monitor_id, status) VALUES (${wrongMon.id}, 'PENDING') RETURNING id`;
  await urlQ.add('check', {
    executionId: wrongExec.id,
    monitor: { id: wrongMon.id, url: wrongMon.url, timeoutMs: wrongMon.timeout_ms },
    assertions: [{ operator: 'equals', statusCode: 404 }],
  });

  console.log('  pushed 3 failure scenarios → waiting for results...');

  const wait = (id: number) =>
    waitFor(async () => {
      const [r] = await sql`SELECT * FROM url_monitor_executions WHERE id = ${id}`;
      return r?.status !== 'PENDING' ? r : null;
    }, 30_000);

  const dnsR = await wait(dnsExec.id);
  const toR = await wait(toExec.id);
  const wrongR = await wait(wrongExec.id);

  record(
    'failure-modes',
    dnsR?.status === 'FAILED',
    `DNS failure: status=${dnsR?.status}, err="${(dnsR?.error_message ?? '').slice(0, 80)}"`,
  );

  record(
    'failure-modes',
    toR?.status === 'FAILED' && /timed?\s*out|abort/i.test(toR.error_message || ''),
    `Timeout: status=${toR?.status}, err="${(toR?.error_message ?? '').slice(0, 80)}"`,
  );

  record(
    'failure-modes',
    wrongR?.status === 'FAILED',
    `Wrong status assertion: status=${wrongR?.status} (expected FAILED because 200 != 404)`,
  );
}

// ============================================================
// 3. Assertion variety in one api-check
// ============================================================
async function assertionVariety() {
  console.log('\n=== 3. Assertion variety: status + time + text + header in one check ===');
  const [check] = await sql`
    INSERT INTO api_checks (name, url, method, headers, timeout_ms)
    VALUES ('multi-assert', 'https://example.com', 'GET', '{}'::jsonb, 10000)
    RETURNING *
  `;
  const [exec] =
    await sql`INSERT INTO api_executions (api_check_id, status) VALUES (${check.id}, 'PENDING') RETURNING *`;

  const assertions = [
    { type: 'status_code', operator: 'equals', path: null, value: '200' },
    { type: 'response_time', operator: 'less_than', path: null, value: '10000' },
    { type: 'text_contains', operator: 'contains', path: null, value: 'Example Domain' },
    {
      type: 'text_contains',
      operator: 'not_contains',
      path: null,
      value: 'this-string-not-in-page',
    },
    { type: 'header', operator: 'contains', path: 'content-type', value: 'text/html' },
  ];

  await apiQ.add('check', {
    executionId: exec.id,
    apiCheck: {
      id: check.id,
      url: check.url,
      method: check.method,
      headers: check.headers,
      timeoutMs: check.timeout_ms,
    },
    assertions,
  });

  const r: any = await waitFor(async () => {
    const [row] = await sql`SELECT * FROM api_executions WHERE id = ${exec.id}`;
    return row?.status !== 'PENDING' ? row : null;
  }, 30_000);

  const passCount = r?.assertion_results?.filter((a: any) => a.passed).length ?? 0;
  console.log(`  result: status=${r?.status}, passed assertions=${passCount}/${assertions.length}`);
  record(
    'assertion-variety',
    r?.status === 'SUCCESS' && passCount === 5,
    `${passCount}/${assertions.length} passed`,
  );
}

// ============================================================
// 4. JSON-path assertion
// ============================================================
async function jsonPathAssertion() {
  console.log('\n=== 4. JSON-path assertion against real JSON API ===');
  const [check] = await sql`
    INSERT INTO api_checks (name, url, method, headers, timeout_ms)
    VALUES ('json-test', 'https://jsonplaceholder.typicode.com/posts/1', 'GET', '{"Accept":"application/json"}'::jsonb, 10000)
    RETURNING *
  `;
  const [exec] =
    await sql`INSERT INTO api_executions (api_check_id, status) VALUES (${check.id}, 'PENDING') RETURNING *`;

  const assertions = [
    { type: 'status_code', operator: 'equals', path: null, value: '200' },
    { type: 'json_path', operator: 'equals', path: '$.userId', value: '1' },
    { type: 'json_path', operator: 'exists', path: '$.title', value: null },
  ];

  await apiQ.add('check', {
    executionId: exec.id,
    apiCheck: {
      id: check.id,
      url: check.url,
      method: check.method,
      headers: check.headers,
      timeoutMs: check.timeout_ms,
    },
    assertions,
  });

  const r: any = await waitFor(async () => {
    const [row] = await sql`SELECT * FROM api_executions WHERE id = ${exec.id}`;
    return row?.status !== 'PENDING' ? row : null;
  }, 30_000);

  const passCount = r?.assertion_results?.filter((a: any) => a.passed).length ?? 0;
  console.log(`  result: status=${r?.status}, passed=${passCount}/${assertions.length}`);
  if (r?.assertion_results) {
    for (const a of r.assertion_results) {
      console.log(`     ${a.passed ? '✅' : '❌'} ${a.type} ${a.operator}: ${a.message}`);
    }
  }
  record(
    'json-path',
    r?.status === 'SUCCESS' && passCount === 3,
    `${passCount}/${assertions.length}`,
  );
}

// ============================================================
// 5. Browser parallelism — 3 qa-project jobs at once
// ============================================================
async function browserParallel() {
  console.log('\n=== 5. Browser parallelism: 3 qa-project jobs in parallel ===');
  const N = 3;

  const targets = ['https://example.com', 'https://example.com', 'https://example.com'];
  const titles = ['Example Domain', 'Example Domain', 'Example Domain'];

  const projects = await Promise.all(
    targets.map(
      (url, i) =>
        sql`INSERT INTO qa_projects (name, target_url, status) VALUES (${'parallel-' + i}, ${url}, 'active') RETURNING *`,
    ),
  );

  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    const project = projects[i][0];
    const expected = titles[i];
    const script = `
import { test, expect } from '@playwright/test';
test('parallel ${i}', async ({ page }) => {
  await page.goto('${targets[i]}');
  await expect(page.locator('h1')).toHaveText('${expected}');
});
`.trim();

    const [t] = await sql`
      INSERT INTO qa_generated_tests (project_id, test_name, test_type, script)
      VALUES (${project.id}, ${'parallel-test-' + i}, 'browser', ${script})
      RETURNING *
    `;

    await qaQ.add('run', {
      type: 'qa-project-run',
      projectId: project.id,
      targetUrl: project.target_url,
      config: { timeout: 30_000 },
      tests: [{ id: t.id, name: t.test_name, script }],
      triggeredAt: new Date().toISOString(),
    });
  }

  console.log(`  pushed ${N} browser jobs → waiting (up to 120s)...`);

  const done = await waitFor(async () => {
    const rows = await sql`
      SELECT COUNT(*) AS c FROM qa_test_executions WHERE status != 'running' AND status IS NOT NULL
    `;
    return Number(rows[0].c) >= N ? rows : null;
  }, 120_000);

  const t = Date.now() - t0;
  const final = await sql`SELECT status, COUNT(*) AS c FROM qa_test_executions GROUP BY status`;
  const passed = Number(final.find((r: any) => r.status === 'passed')?.c ?? 0);
  console.log(`  ${N} browser jobs finished in ${t}ms. passed=${passed}`);
  record('browser-parallel', passed >= N && !!done, `${passed}/${N} passed in ${t}ms`);
}

// ============================================================
// Run all
// ============================================================
await concurrencyBurst();
await failureModes();
await assertionVariety();
await jsonPathAssertion();
await browserParallel();

console.log('\n========================= SUMMARY =========================');
let totalP = 0,
  totalF = 0;
for (const [name, r] of Object.entries(results)) {
  const passed = r.failed === 0;
  console.log(`\n${passed ? '✅' : '❌'} ${name}  (passed=${r.passed} failed=${r.failed})`);
  for (const d of r.details) console.log(`     ${d}`);
  totalP += r.passed;
  totalF += r.failed;
}
console.log(`\n========================================`);
console.log(`  TOTAL: ${totalP} passed / ${totalF} failed`);
console.log(`========================================`);

await urlQ.close();
await apiQ.close();
await qaQ.close();
await sql.end();
await connection.quit();
process.exit(totalF === 0 ? 0 : 1);
