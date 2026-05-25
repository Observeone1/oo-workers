/**
 * Pure regression guard for the SaaS→self-host adapter.
 * Ported from scripts/import-from-saas-test.ts.
 * No DB, no network — all assertions are on the adapter's output shape.
 */

import { describe, test, expect } from 'bun:test';
import { adaptSaaSExport } from '../../scripts/adapt-cli-export.ts';

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
  heartbeats: [
    {
      name: 'web-cron',
      description: 'nightly batch',
      period: 3600,
      grace_period: 300,
      ping_key: 'kept-from-saas-EXISTING-TOKEN',
      alert_on_failure: true,
    },
    { name: 'legacy-cron', period: 600, grace_period: 60 },
    { name: 'too-fast', period: 5, grace_period: 0 },
  ],
  suites: [
    {
      suite_name: 'checkout',
      target_url: 'https://x.io/app',
      cron_expression: '*/15 * * * *',
      schedule_active: true,
      max_tests: 5,
      secret_keys: ['STRIPE_KEY'],
      tests: [{ name: 'login', script: 'await page.goto("/")' }],
    },
    { suite_name: 'no-scripts', target_url: 'https://x.io', schedule_active: false },
  ],
  alert_channels: [
    { name: 'ops-email', type: 'email', config: { email: 'ops@x.io' } },
    { name: 'slack-alerts', type: 'slack', config: { webhook_url: 'https://hooks.slack.com/aaa' } },
    { name: 'tg', type: 'telegram', config: { bot_token: 'SECRET_BOT_TOKEN_LEAK', chat_id: '999' } },
    { name: 'pager', type: 'sms', config: { account_sid: 'SECRET_SID_LEAK', auth_token: 'SECRET_AUTH_LEAK' } },
    { name: 'bad-mail', type: 'email', config: { email: 'no-at-sign' } },
    { name: 'bad-hook', type: 'slack', config: { webhook_url: 'ftp://nope' } },
  ],
  status_pages: [],
  incidents: [{ a: 1 }],
};

describe('adapt-saas-export: top-level structure', () => {
  const { payload, skipped, warnings } = adaptSaaSExport(SAAS);
  const flat = JSON.stringify(payload);

  test('version is 1', () => expect(payload.version).toBe(1));

  test('camelCase top-level keys present', () => {
    expect(Array.isArray(payload.urlMonitors)).toBe(true);
    expect(Array.isArray(payload.apiChecks)).toBe(true);
    expect(Array.isArray(payload.qaProjects)).toBe(true);
  });

  test('no snake_case keys leak (the regression)', () => {
    expect(flat).not.toContain('url_monitors');
    expect(flat).not.toContain('api_checks');
    expect(flat).not.toContain('status_code');
    expect(flat).not.toContain('timeout_ms');
    expect(flat).not.toContain('interval_seconds');
  });

  test('urlMonitor fields match /api/import', () => {
    const um = payload.urlMonitors[0];
    expect(um.name).toBe('home');
    expect(um.url).toBe('https://x.io');
    expect(um.timeoutMs).toBe(8000);
    expect(um.intervalSeconds).toBe(300);
    expect(um.enabled).toBe(true);
  });

  test('urlMonitor assertion is {operator,statusCode}', () => {
    const um = payload.urlMonitors[0];
    expect(um.assertions[0].operator).toBe('equals');
    expect(um.assertions[0].statusCode).toBe(200);
  });

  test('apiCheck fields match /api/import', () => {
    const ac = payload.apiChecks[0];
    expect(ac.name).toBe('health');
    expect(ac.method).toBe('POST');
    expect(ac.timeoutMs).toBe(10000);
    expect(ac.intervalSeconds).toBe(60);
    expect(ac.headers['x-a']).toBe('b');
    expect(ac.body).toBe('{}');
  });

  test('apiCheck assertion shape', () => {
    const aa = payload.apiChecks[0].assertions[0];
    expect(aa.type).toBe('status');
    expect(aa.operator).toBe('equals');
    expect(aa.path).toBe('$.ok');
    expect(aa.value).toBe('200');
  });

  test('skipped counts surfaced', () => {
    expect(skipped.heartbeats_malformed).toBe(1);
    expect(skipped.suites).toBe(1);
    expect(skipped.alert_channels).toBe(4);
    expect(skipped.incidents).toBe(1);
  });

  test('heartbeat: ping_key carried through as token', () => {
    const hb = payload.heartbeats ?? [];
    const wc = hb.find((h) => h.name === 'web-cron');
    expect(wc?.token).toBe('kept-from-saas-EXISTING-TOKEN');
    expect(wc?.periodSeconds).toBe(3600);
    expect(wc?.graceSeconds).toBe(300);
    expect(wc?.description).toBe('nightly batch');
  });

  test('heartbeat: legacy CLI (no ping_key) imports without token', () => {
    const hb = payload.heartbeats ?? [];
    const lc = hb.find((h) => h.name === 'legacy-cron');
    expect(lc?.token).toBeUndefined();
    expect(lc?.periodSeconds).toBe(600);
  });

  test('heartbeat: too-fast (< 30s) dropped', () => {
    const hb = payload.heartbeats ?? [];
    expect(hb.find((h) => h.name === 'too-fast')).toBeUndefined();
  });

  test('tokenless export emits a "rotate ping URL" warning', () => {
    expect(warnings.some((w) => /ping_key/i.test(w) && /ping URL/i.test(w))).toBe(true);
  });

  test('exactly the scripted suite is mapped', () => {
    expect(payload.qaProjects.length).toBe(1);
    const qp = payload.qaProjects[0];
    expect(qp.name).toBe('checkout');
    expect(qp.targetUrl).toBe('https://x.io/app');
    expect(qp.intervalSeconds).toBe(900);
    expect(qp.enabled).toBe(true);
  });

  test('exactly 2 valid channels map', () => {
    expect(payload.channels.length).toBe(2);
  });

  test('email channel has correct config', () => {
    const ch = payload.channels.find((c) => c.name === 'ops-email');
    expect(ch?.type).toBe('email');
    expect(ch?.config).toEqual({ to: 'ops@x.io' });
  });

  test('slack channel config.url from webhook_url', () => {
    const ch = payload.channels.find((c) => c.name === 'slack-alerts');
    expect(ch?.type).toBe('slack');
    expect((ch?.config as { url: string }).url).toBe('https://hooks.slack.com/aaa');
  });

  test('no secret leaks from skipped channels', () => {
    const f = JSON.stringify(payload);
    expect(f).not.toContain('SECRET_BOT_TOKEN_LEAK');
    expect(f).not.toContain('SECRET_SID_LEAK');
    expect(f).not.toContain('SECRET_AUTH_LEAK');
    expect(f).not.toContain('bot_token');
    expect(f).not.toContain('account_sid');
  });

  test('adapter emits the suite-secrets warning', () => {
    expect(warnings.some((w) => w.includes('checkout') && w.includes('STRIPE_KEY'))).toBe(true);
  });
});

describe('adapt-saas-export: v1.25.0 surrogate-id remap', () => {
  const V125 = adaptSaaSExport({
    monitors: [{ id: 100, name: 'home', url: 'https://x.io', timeout_ms: 8000, channel_ids: [10, 11] }],
    api_checks: [{ id: 200, name: 'health', url: 'https://x.io/h', method: 'GET', cron_expression: '*/2 * * * *', assertions: [], channel_ids: [11] }],
    alert_channels: [
      { id: 10, name: 'ops-email', type: 'email', config: { email: 'ops@x.io' } },
      { id: 11, name: 'slack-alerts', type: 'slack', config: { webhook_url: 'https://hooks.slack.com/aaa' } },
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

  test('monitor id + channelRefs carried through', () => {
    const u = V125.payload.urlMonitors[0];
    expect(u.id).toBe(100);
    expect(u.channelRefs).toEqual([10, 11]);
  });

  test('api_check id + channelRefs carried through', () => {
    const a = V125.payload.apiChecks[0];
    expect(a.id).toBe(200);
    expect(a.channelRefs).toEqual([11]);
  });

  test('channel ids carried through', () => {
    const email = V125.payload.channels.find((c) => c.name === 'ops-email');
    const slack = V125.payload.channels.find((c) => c.name === 'slack-alerts');
    expect(email?.id).toBe(10);
    expect(slack?.id).toBe(11);
  });

  test('statusPages emitted with refs + type normalized', () => {
    const sp = V125.payload.statusPages?.[0];
    expect(sp?.slug).toBe('public');
    expect(sp?.monitors[0]).toEqual({ ref: 100, type: 'url' });
    expect(sp?.monitors[1]).toEqual({ ref: 200, type: 'api' });
  });
});

describe('adapt-saas-export: pre-1.25.0 export (no ids)', () => {
  const PRE = adaptSaaSExport({
    monitors: [{ name: 'home', url: 'https://x.io', timeout_ms: 1 }],
    api_checks: [{ name: 'health', url: 'https://x.io/h', method: 'GET', assertions: [] }],
    alert_channels: [{ name: 'ops-email', type: 'email', config: { email: 'a@b.c' } }],
    status_pages: [{ slug: 'public', name: 'Public', monitors: [{ monitor_type: 'url', monitor_id: 100 }] }],
  });

  test('no id field in urlMonitors', () => {
    expect(PRE.payload.urlMonitors[0].id).toBeUndefined();
    expect('channelRefs' in PRE.payload.urlMonitors[0]).toBe(false);
  });

  test('no id field in apiChecks', () => expect(PRE.payload.apiChecks[0].id).toBeUndefined());
  test('no id field in channels', () => expect(PRE.payload.channels[0].id).toBeUndefined());
});

describe('adapt-saas-export: enabled-state fidelity', () => {
  const ef = adaptSaaSExport({
    monitors: [
      { name: 'off-url', url: 'https://x.io/o', timeout_ms: 1, enabled: false },
      { name: 'paused-url', url: 'https://x.io/p', timeout_ms: 1, is_paused: true },
      { name: 'default-url', url: 'https://x.io/d', timeout_ms: 1 },
    ],
    api_checks: [
      { name: 'off-api', url: 'https://x.io/a', method: 'GET', assertions: [], enabled: false },
      { name: 'on-api', url: 'https://x.io/b', method: 'GET', assertions: [] },
    ],
  });
  const urlMap = Object.fromEntries(ef.payload.urlMonitors.map((m) => [m.name, m]));
  const apiMap = Object.fromEntries(ef.payload.apiChecks.map((m) => [m.name, m]));

  test('enabled:false → disabled on import', () => expect(urlMap['off-url'].enabled).toBe(false));
  test('is_paused:true → disabled on import', () => expect(urlMap['paused-url'].enabled).toBe(false));
  test('absent enabled → true (back-compat)', () => expect(urlMap['default-url'].enabled).toBe(true));
  test('api_check enabled:false → disabled', () => expect(apiMap['off-api'].enabled).toBe(false));
  test('api_check absent → true', () => expect(apiMap['on-api'].enabled).toBe(true));
});

describe('adapt-saas-export: edge cases', () => {
  test('empty input → no throw, empty collections', () => {
    const r = adaptSaaSExport({});
    expect(r.payload.qaProjects.length).toBe(0);
    expect(r.payload.channels.length).toBe(0);
    expect(r.warnings.length).toBe(0);
  });

  test('malformed suite (no suite_name) is skipped', () => {
    const r = adaptSaaSExport({ suites: [{ target_url: 'x', tests: [{ name: 'a', script: 'b' }] }] });
    expect(r.payload.qaProjects.length).toBe(0);
    expect(r.skipped.suites).toBe(1);
  });

  test('unknown channel type skipped', () => {
    const r = adaptSaaSExport({ alert_channels: [{ name: 'pd', type: 'pagerduty', config: { webhook_url: 'https://x' } }] });
    expect(r.payload.channels.length).toBe(0);
    expect(r.skipped.alert_channels).toBe(1);
  });

  test('empty status_page skipped', () => {
    const r = adaptSaaSExport({ status_pages: [{ slug: 'lonely', name: 'Lonely' }] });
    expect(r.payload.statusPages).toBeUndefined();
    expect(r.skipped.status_pages).toBe(1);
  });
});
