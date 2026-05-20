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
  alert_channels: [
    // Mappable.
    { name: 'ops-email', type: 'email', config: { email: 'ops@x.io' } },
    { name: 'slack-alerts', type: 'slack', config: { webhook_url: 'https://hooks.slack.com/aaa' } },
    // Unsupported types — skipped; their SECRETS must never leak.
    {
      name: 'tg',
      type: 'telegram',
      config: { bot_token: 'SECRET_BOT_TOKEN_LEAK', chat_id: '999' },
    },
    {
      name: 'pager',
      type: 'sms',
      config: { account_sid: 'SECRET_SID_LEAK', auth_token: 'SECRET_AUTH_LEAK' },
    },
    // Right type, broken endpoint — skipped, not half-created.
    { name: 'bad-mail', type: 'email', config: { email: 'no-at-sign' } },
    { name: 'bad-hook', type: 'slack', config: { webhook_url: 'ftp://nope' } },
  ],
  status_pages: [],
  incidents: [{ a: 1 }],
};

const { payload, skipped, warnings } = adaptSaaSExport(SAAS);
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
    // 4 not brought across: telegram, sms, bad email, bad webhook url.
    skipped.alert_channels === 4 &&
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

// 7. alert_channels→channels (3.2): only supported types with a valid
//    endpoint map; config is narrowed to {to}|{url}.
check('exactly the 2 valid channels map', payload.channels.length === 2);
const byName = Object.fromEntries(payload.channels.map((c) => [c.name, c]));
check(
  'email channel → {type:email, config:{to}}',
  byName['ops-email']?.type === 'email' &&
    JSON.stringify(byName['ops-email']?.config) === JSON.stringify({ to: 'ops@x.io' }),
  JSON.stringify(byName['ops-email']),
);
check(
  'slack channel → {type:slack, config:{url}} from webhook_url',
  byName['slack-alerts']?.type === 'slack' &&
    JSON.stringify(byName['slack-alerts']?.config) ===
      JSON.stringify({ url: 'https://hooks.slack.com/aaa' }),
  JSON.stringify(byName['slack-alerts']),
);

// 7b. SECRETS MUST NOT LEAK — the skipped telegram/sms channels carry
//     bot_token/account_sid; none may appear anywhere in the payload.
const flatAll = JSON.stringify(payload);
check(
  'no skipped-channel secret leaks into the payload',
  !flatAll.includes('SECRET_BOT_TOKEN_LEAK') &&
    !flatAll.includes('SECRET_SID_LEAK') &&
    !flatAll.includes('SECRET_AUTH_LEAK') &&
    !flatAll.includes('bot_token') &&
    !flatAll.includes('account_sid'),
  flatAll,
);

// 7c. Channel negative controls — gate must bite.
check('empty input → no channels, no throw', adaptSaaSExport({}).payload.channels.length === 0);
const unknownType = adaptSaaSExport({
  alert_channels: [{ name: 'pd', type: 'pagerduty', config: { webhook_url: 'https://x' } }],
});
check(
  'unknown channel type (pagerduty) skipped, no crash',
  unknownType.payload.channels.length === 0 && unknownType.skipped.alert_channels === 1,
  JSON.stringify(unknownType),
);
const noName = adaptSaaSExport({
  alert_channels: [{ type: 'slack', config: { webhook_url: 'https://hooks.slack.com/z' } }],
});
check(
  'channel with no name is skipped, never named undefined',
  noName.payload.channels.length === 0 &&
    noName.skipped.alert_channels === 1 &&
    !JSON.stringify(noName.payload).includes('undefined'),
  JSON.stringify(noName),
);

// 8. Adapter warnings (v1.13.2). Only SaaS-export-derived advisories
//    live here — the monitor→channel binding advisory is emitted
//    SERVER-side by /api/import (path-independent), NOT by the adapter.
check(
  'exactly one adapter warning — the imported suite uses unmigrated secrets',
  warnings.length === 1 && warnings[0].includes('checkout') && warnings[0].includes('STRIPE_KEY'),
  JSON.stringify(warnings),
);
check(
  'adapter does NOT emit the binding advisory (that is server-side)',
  !warnings.some((w) => /alert-channel|routing|bind/i.test(w)),
  JSON.stringify(warnings),
);
// Anti-vacuous: a mapped suite with NO secret_keys → no warning.
const noSecret = adaptSaaSExport({
  monitors: [{ name: 'm', url: 'https://x', timeout_ms: 1 }],
  suites: [{ suite_name: 's', target_url: 'https://y', tests: [{ name: 'a', script: 'b' }] }],
});
check(
  'mapped suite without secret_keys produces NO warning (and no binding warning here)',
  noSecret.payload.qaProjects.length === 1 && noSecret.warnings.length === 0,
  JSON.stringify(noSecret.warnings),
);
check('empty input → no warnings, no throw', adaptSaaSExport({}).warnings.length === 0);

// 9. CLI v1.25.0 surrogate-id remap (Roadmap 3.3). The adapter must:
//    - carry `id` through from monitors/api_checks/alert_channels,
//    - normalize SaaS `channel_ids` → `channelRefs` on monitors,
//    - emit `statusPages[]` with `monitors[].ref` resolved from
//      `status_pages[].monitors[].monitor_id`,
//    - normalize `monitor_type: 'api_check'` → `'api'`.
//    Server-side resolution to real DB ids is covered separately by the
//    live-server gating script (scripts/import-remap-test.ts).
const V125 = adaptSaaSExport({
  monitors: [
    { id: 100, name: 'home', url: 'https://x.io', timeout_ms: 8000, channel_ids: [10, 11] },
  ],
  api_checks: [
    {
      id: 200,
      name: 'health',
      url: 'https://x.io/h',
      method: 'GET',
      cron_expression: '*/2 * * * *',
      assertions: [],
      channel_ids: [11],
    },
  ],
  alert_channels: [
    { id: 10, name: 'ops-email', type: 'email', config: { email: 'ops@x.io' } },
    {
      id: 11,
      name: 'slack-alerts',
      type: 'slack',
      config: { webhook_url: 'https://hooks.slack.com/aaa' },
    },
  ],
  status_pages: [
    {
      slug: 'public',
      name: 'Public status',
      monitors: [
        { monitor_type: 'url', monitor_id: 100, display_name: 'Home' },
        { monitor_type: 'api_check', monitor_id: 200, display_name: 'Health' },
      ],
    },
  ],
});
const v125Url = V125.payload.urlMonitors[0];
const v125Api = V125.payload.apiChecks[0];
const v125Email = V125.payload.channels.find((c) => c.name === 'ops-email');
const v125Slack = V125.payload.channels.find((c) => c.name === 'slack-alerts');
check(
  'v1.25.0 monitor id + channelRefs carried through',
  v125Url.id === 100 && JSON.stringify(v125Url.channelRefs) === JSON.stringify([10, 11]),
  JSON.stringify(v125Url),
);
check(
  'v1.25.0 api_check id + channelRefs carried through',
  v125Api.id === 200 && JSON.stringify(v125Api.channelRefs) === JSON.stringify([11]),
  JSON.stringify(v125Api),
);
check(
  'v1.25.0 channel ids carried through',
  v125Email?.id === 10 && v125Slack?.id === 11,
  JSON.stringify({ email: v125Email, slack: v125Slack }),
);
check(
  'v1.25.0 statusPages emitted with monitor refs + type normalized',
  V125.payload.statusPages?.length === 1 &&
    V125.payload.statusPages[0].slug === 'public' &&
    V125.payload.statusPages[0].title === 'Public status' &&
    V125.payload.statusPages[0].monitors.length === 2 &&
    V125.payload.statusPages[0].monitors[0].ref === 100 &&
    V125.payload.statusPages[0].monitors[0].type === 'url' &&
    V125.payload.statusPages[0].monitors[1].ref === 200 &&
    V125.payload.statusPages[0].monitors[1].type === 'api',
  JSON.stringify(V125.payload.statusPages),
);

// 9b. NEGATIVE CONTROL — anti-vacuous proof the remap is *gated*, not
//     always-on. A pre-1.25.0 SaaS export with NO id fields must:
//     - import monitors/channels/api_checks normally (no regression),
//     - emit NO `id` / `channelRefs` keys (no fabrication),
//     - omit `statusPages` entirely (since no monitor_id can resolve).
//     If the new code ever ran always-on (forgot the `id !== undefined`
//     guard) this case would FAIL — a passing v9 + failing v9b means the
//     gate has rotted.
const PRE_125 = adaptSaaSExport({
  monitors: [{ name: 'home', url: 'https://x.io', timeout_ms: 1 }],
  api_checks: [{ name: 'health', url: 'https://x.io/h', method: 'GET', assertions: [] }],
  alert_channels: [{ name: 'ops-email', type: 'email', config: { email: 'a@b.c' } }],
  status_pages: [
    {
      slug: 'public',
      name: 'Public',
      // monitors[].monitor_id present, but no id on the monitor in the
      // bundle — refs can't resolve → page must be skipped, not made.
      monitors: [{ monitor_type: 'url', monitor_id: 100 }],
    },
  ],
});
const pre = PRE_125.payload;
check(
  'pre-1.25.0 export: no id field leaks into urlMonitors',
  pre.urlMonitors[0].id === undefined && !('channelRefs' in pre.urlMonitors[0]),
  JSON.stringify(pre.urlMonitors[0]),
);
check(
  'pre-1.25.0 export: no id field leaks into apiChecks',
  pre.apiChecks[0].id === undefined && !('channelRefs' in pre.apiChecks[0]),
  JSON.stringify(pre.apiChecks[0]),
);
check(
  'pre-1.25.0 export: no id field leaks into channels',
  pre.channels[0].id === undefined,
  JSON.stringify(pre.channels[0]),
);
// On status_pages: the adapter passes them through (responsibility for
// dangle-detection lives server-side — see #9d's rationale). Here we
// only assert that NO surrogate id was fabricated into the bundle —
// any monitor refs in the page MUST match what was in the SaaS export
// verbatim, not invented ones.
check(
  'pre-1.25.0 export: adapter does not fabricate surrogate ids',
  pre.urlMonitors.every((m) => m.id === undefined) &&
    pre.apiChecks.every((m) => m.id === undefined) &&
    pre.channels.every((c) => c.id === undefined),
  JSON.stringify(pre),
);

// 9c. status_pages with NO monitors[] section → skipped (an empty status
//     page is hollow, no value created). Counts toward skipped.status_pages.
const emptySP = adaptSaaSExport({
  status_pages: [{ slug: 'lonely', name: 'Lonely' }],
});
check(
  'empty status_page (no monitors) is skipped, not created hollow',
  emptySP.payload.statusPages === undefined && emptySP.skipped.status_pages === 1,
  JSON.stringify(emptySP),
);

// 9d. status_pages whose refs all point at monitors NOT in this bundle
//     (e.g. partial export). Skipped — server can't wire a dangling ref.
const danglingSP = adaptSaaSExport({
  monitors: [{ id: 1, name: 'a', url: 'https://x', timeout_ms: 1 }],
  status_pages: [
    {
      slug: 'dangling',
      name: 'Dangling',
      monitors: [{ monitor_type: 'url', monitor_id: 999 /* not in bundle */ }],
    },
  ],
});
// At the adapter level we DO emit the page+ref unchanged — resolution
// happens server-side. The dangling ref skip count + warning happen
// there. This checks the adapter doesn't pre-emptively drop the SP.
check(
  'adapter emits status_page even when refs may dangle (resolution is server-side)',
  danglingSP.payload.statusPages?.length === 1 &&
    danglingSP.payload.statusPages[0].monitors[0].ref === 999,
  JSON.stringify(danglingSP),
);

console.log(
  failed ? '\nimport-from-saas-test: FAILED' : '\nimport-from-saas-test: all checks passed',
);
process.exit(failed ? 1 : 0);
