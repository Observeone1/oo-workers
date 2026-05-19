#!/usr/bin/env bun
/**
 * Regression guard for SaaS→self-host import.
 *
 * The bug this feature fixed: `adapt-cli-export.ts` emitted snake_case
 * (`url_monitors`, `status_code`, `timeout_ms`) while `POST /api/import`
 * reads camelCase (`urlMonitors`, `statusCode`, `timeoutMs`), so the
 * documented two-step imported ZERO rows, silently. This asserts the
 * adapter output is exactly the shape `/api/import` consumes — pure, no
 * DB/server. The expected keys below MIRROR src/server.ts (the
 * `body.urlMonitors`/`body.apiChecks` import handler); keep them in sync
 * if that endpoint's accepted schema changes.
 *
 * Run standalone: `bun scripts/import-from-saas-test.ts`
 * Also a stage in scripts/run-integration.sh.
 */

import { adaptSaaSExport } from './adapt-cli-export.ts';

let failed = false;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = true;
}

const SAAS = {
  monitors: [{ name: 'home', url: 'https://x.io', timeout_ms: 8000, interval: '*/5 * * * *' }],
  api_checks: [
    {
      name: 'health',
      url: 'https://x.io/h',
      method: 'POST',
      headers: { 'x-a': 'b' },
      body: '{}',
      cron_expression: '* * * * *',
      assertions: [{ type: 'status', operator: 'equals', value: '200', path: '$.ok' }],
    },
  ],
  heartbeats: [{ a: 1 }],
  suites: [
    // Mappable: has suite_name + target_url + inline scripts.
    {
      suite_name: 'checkout',
      target_url: 'https://x.io/app',
      cron_expression: '*/15 * * * *',
      schedule_active: true,
      max_tests: 5,
      secret_keys: ['STRIPE_KEY'],
      tests: [{ name: 'login', script: 'await page.goto("/")' }],
    },
    // Not mappable: no inline scripts (export run without --include-scripts).
    { suite_name: 'no-scripts', target_url: 'https://x.io', schedule_active: false },
  ],
  alert_channels: [{ a: 1 }],
  status_pages: [],
  incidents: [{ a: 1 }],
};

const { payload, skipped } = adaptSaaSExport(SAAS);
const flat = JSON.stringify(payload);

// 1. Top-level keys are exactly what /api/import reads (camelCase), and
//    the old snake_case keys that caused the silent-zero bug are absent.
check('version is 1', payload.version === 1);
check(
  'camelCase top-level keys present',
  Array.isArray(payload.urlMonitors) &&
    Array.isArray(payload.apiChecks) &&
    Array.isArray(payload.qaProjects),
);
check(
  'no snake_case keys leak (the regression)',
  !flat.includes('url_monitors') &&
    !flat.includes('api_checks') &&
    !flat.includes('status_code') &&
    !flat.includes('timeout_ms') &&
    !flat.includes('interval_seconds'),
);

// 2. url monitor field shape + cron→seconds.
const um = payload.urlMonitors[0];
check(
  'urlMonitor fields match /api/import',
  um.name === 'home' &&
    um.url === 'https://x.io' &&
    um.timeoutMs === 8000 &&
    um.intervalSeconds === 300 &&
    um.enabled === true,
  JSON.stringify(um),
);
check(
  'urlMonitor assertion is {operator,statusCode}',
  um.assertions[0].operator === 'equals' && um.assertions[0].statusCode === 200,
);

// 3. api check field shape + assertion mapping + cron→60.
const ac = payload.apiChecks[0];
check(
  'apiCheck fields match /api/import',
  ac.name === 'health' &&
    ac.method === 'POST' &&
    ac.timeoutMs === 10000 &&
    ac.intervalSeconds === 60 &&
    ac.headers['x-a'] === 'b' &&
    ac.body === '{}',
  JSON.stringify(ac),
);
const aa = ac.assertions[0];
check(
  'apiCheck assertion is {type,operator,path,value}',
  aa.type === 'status' && aa.operator === 'equals' && aa.path === '$.ok' && aa.value === '200',
);

// 4. Still-skipped SaaS-only resources are reported, not silently
//    dropped. `suites` now means "suites NOT brought across" — here the
//    1 no-scripts suite (the 'checkout' one IS mapped, below).
check(
  'skipped counts surfaced',
  skipped.heartbeats === 1 &&
    skipped.suites === 1 &&
    skipped.alert_channels === 1 &&
    skipped.incidents === 1,
  JSON.stringify(skipped),
);

// 5. suites→qaProjects (3.1): only the scripted suite maps, with the
//    exact shape /api/import's qaProjects branch consumes; cron→QA
//    interval; schedule_active→enabled.
check('exactly the scripted suite is mapped', payload.qaProjects.length === 1);
const qp = payload.qaProjects[0];
check(
  'qaProject fields match /api/import',
  qp.name === 'checkout' &&
    qp.targetUrl === 'https://x.io/app' &&
    qp.intervalSeconds === 900 &&
    qp.enabled === true,
  JSON.stringify(qp),
);
check(
  'qaProject tests are {name,script}',
  qp.tests.length === 1 && qp.tests[0].name === 'login' && qp.tests[0].script.includes('page.goto'),
  JSON.stringify(qp.tests),
);

// 6. Negative controls — the gate must bite, not be tautological.
const empty = adaptSaaSExport({});
check('empty input → no qaProjects, no throw', empty.payload.qaProjects.length === 0);
const malformed = adaptSaaSExport({
  suites: [{ target_url: 'x', tests: [{ name: 'a', script: 'b' }] }], // no suite_name
});
check(
  'malformed suite (no suite_name) is skipped, never a project named undefined',
  malformed.payload.qaProjects.length === 0 &&
    malformed.skipped.suites === 1 &&
    !JSON.stringify(malformed.payload).includes('undefined'),
  JSON.stringify(malformed),
);
const scriptless = adaptSaaSExport({
  suites: [{ suite_name: 's', target_url: 'https://y.io' }], // no tests[]
});
check(
  'scriptless suite is skipped (no silent empty QA project)',
  scriptless.payload.qaProjects.length === 0 && scriptless.skipped.suites === 1,
  JSON.stringify(scriptless),
);

console.log(
  failed ? '\nimport-from-saas-test: FAILED' : '\nimport-from-saas-test: all checks passed',
);
process.exit(failed ? 1 : 0);
