import { createServer, type Server } from 'node:http';
import {
  test,
  expect,
  uniqueSuffix,
  deleteMonitorViaApi,
  ensureSessionAccount,
} from './fixtures';
import { mailpitReachable, clearMailpit, waitForMessage } from './mailpit';
import { adaptSaaSExport } from '../../scripts/adapt-cli-export.ts';

/**
 * Real-path e2e for the SaaS→self-host import (v1.12.0 suites→qaProjects,
 * v1.13.0 alert_channels→channels). MANUAL only — Playwright is not in CI
 * by repo policy; scripts/import-from-saas-test.ts is the CI gate but it
 * is PURE (adapter only). Nothing else ever executes the /api/import
 * qaProjects + channels branches — run-integration.sh boots src/index.ts
 * (workers-only, no HTTP server). This drives the actual user pipeline:
 *
 *   realistic obs.json  →  real adaptSaaSExport()  →  POST /api/import
 *   (live :3010 stack)  →  behavioural assertions, no shortcuts.
 *
 * Assertions are behavioural, not "a row exists":
 *  - qaProject + its test read back through the public API; scriptless
 *    suite created NOTHING.
 *  - imported email channel → POST /:id/test → the mail actually lands
 *    in Mailpit at the IMPORTED recipient (proves config.to persisted).
 *  - imported webhook channel → POST /:id/test → a spec-local catch-all
 *    actually receives the alert at the IMPORTED url (proves config.url).
 *  - telegram channel is skipped → no row exists → its bot_token secret
 *    physically cannot be in the DB.
 *
 * HONEST RESIDUAL: the fixture mirrors the verified export.ts shape but
 * CANNOT catch SaaS list-endpoint field omissions (see context repo
 * plans/2026-05-19-observeone-cli-export-gaps.md, Gap 2) — only a real
 * SaaS-instance capture can. This e2e does not pretend to close that.
 *
 * Prereq: dev stack on :3010 (worker running) + Mailpit (:8025).
 * Visible-yellow skip — never silent-green — if auth or Mailpit is down.
 */

test('SaaS export → adapter → /api/import: qa suites + channels land and work', async ({
  request,
}) => {
  test.setTimeout(120_000);

  if (!process.env.OO_E2E_API_KEY) {
    test.skip(
      !(await ensureSessionAccount(request)),
      'no usable auth — set OO_E2E_API_KEY or use a fresh stack',
    );
  }
  test.skip(
    !(await mailpitReachable()),
    'Mailpit unreachable — start it via start-oo-workers.sh (dev :8025)',
  );

  const sfx = uniqueSuffix();
  const recipient = `imp-${sfx}@example.com`;

  // Spec-local catch-all: the imported webhook channel points here, so a
  // received request proves config.url was persisted AND dispatches.
  const hooks: Array<{ url: string; body: string }> = [];
  const server: Server = createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      hooks.push({ url: req.url ?? '', body: buf });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr !== 'object') throw new Error('no catch-all address');
  const hookUrl = `http://127.0.0.1:${addr.port}/hook`;

  // A faithful replica of the real `obs export` shape (per the verified
  // ObserveOne-CLI/src/commands/export.ts mapping).
  const saas = {
    monitors: [
      { name: `imp-url-${sfx}`, url: 'https://example.com', timeout_ms: 10_000, interval: '*/5 * * * *' },
    ],
    api_checks: [],
    heartbeats: [],
    status_pages: [],
    incidents: [],
    suites: [
      {
        suite_name: `imp-suite-${sfx}`,
        target_url: 'https://example.com/app',
        cron_expression: '*/15 * * * *',
        schedule_active: true,
        tests: [{ name: 'login', script: 'await page.goto("/")' }],
      },
      // No inline scripts → must NOT create an empty QA project.
      { suite_name: `imp-noscript-${sfx}`, target_url: 'https://example.com' },
    ],
    alert_channels: [
      { name: `imp-email-${sfx}`, type: 'email', config: { email: recipient } },
      { name: `imp-hook-${sfx}`, type: 'webhook', config: { webhook_url: hookUrl } },
      // Unsupported type: skipped → no row → its secret can't reach the DB.
      { name: `imp-tg-${sfx}`, type: 'telegram', config: { bot_token: `SECRET_TG_${sfx}`, chat_id: '1' } },
    ],
  };

  // The real adapter — same call the wrapper makes.
  const { payload } = adaptSaaSExport(saas as Parameters<typeof adaptSaaSExport>[0]);
  expect(payload.qaProjects.length, 'adapter maps only the scripted suite').toBe(1);
  expect(payload.channels.length, 'adapter maps only email + webhook').toBe(2);

  let qaId = 0;
  const channelIds: number[] = [];
  let urlId = 0;
  try {
    await clearMailpit();

    // --- The real round-trip: POST the adapter output to /api/import ---
    const imp = await request.post('/api/import', { data: payload });
    expect(imp.ok(), `/api/import: ${imp.status()} ${await imp.text()}`).toBeTruthy();
    const created = (await imp.json()) as {
      url: number;
      qa: number;
      channels: number;
      skipped: string[];
      warnings: string[];
    };
    expect(created.url, 'url monitor imported').toBe(1);
    expect(created.qa, 'exactly the scripted suite imported as a qaProject').toBe(1);
    expect(created.channels, 'exactly email + webhook imported').toBe(2);
    expect(created.skipped, 'no per-item server creation errors').toEqual([]);
    // v1.13.2: server emits the path-independent binding advisory so the
    // UI dialog + CLI both see it. Monitors were imported → it must fire.
    expect(
      created.warnings.some((w) => /no alert-channel bindings/i.test(w)),
      'server warns that imported monitors have no channel bindings',
    ).toBe(true);

    // --- 3.1: qaProject + its test, read back through the public API ---
    const monitors = (await (await request.get('/api/monitors')).json()) as {
      url: Array<{ name: string; id: number }>;
      qa: Array<{ name: string; id: number }>;
    };
    const urlRow = monitors.url.find((m) => m.name === `imp-url-${sfx}`);
    urlId = urlRow?.id ?? 0;
    const qaRow = monitors.qa.find((m) => m.name === `imp-suite-${sfx}`);
    expect(qaRow, 'imported qaProject is listed').toBeTruthy();
    expect(
      monitors.qa.some((m) => m.name === `imp-noscript-${sfx}`),
      'scriptless suite created NOTHING (no empty QA project)',
    ).toBe(false);
    qaId = qaRow!.id;

    const qaDetail = (await (await request.get(`/api/monitors/qa/${qaId}`)).json()) as {
      monitor: { name: string; targetUrl: string; intervalSeconds: number };
      tests: Array<{ testName: string }>;
    };
    expect(qaDetail.monitor.targetUrl).toBe('https://example.com/app');
    expect(qaDetail.monitor.intervalSeconds, 'cron */15 → 900s').toBe(900);
    expect(
      qaDetail.tests.map((t) => t.testName),
      'the imported test row landed under the project',
    ).toContain('login');

    // --- 3.2: channels — prove config persisted BEHAVIOURALLY ---
    const chans = (await (await request.get('/api/channels')).json()) as Array<{
      id: number;
      name: string;
      type: string;
    }>;
    const emailCh = chans.find((c) => c.name === `imp-email-${sfx}`);
    const hookCh = chans.find((c) => c.name === `imp-hook-${sfx}`);
    expect(emailCh, 'email channel imported').toBeTruthy();
    expect(hookCh, 'webhook channel imported').toBeTruthy();
    expect(
      chans.some((c) => c.name === `imp-tg-${sfx}`),
      'telegram channel skipped — no row exists, so its bot_token cannot be in the DB',
    ).toBe(false);
    channelIds.push(emailCh!.id, hookCh!.id);

    // Email: send a test through the imported channel → it must actually
    // land in Mailpit addressed to the IMPORTED recipient. This is the
    // only way to prove config.to was stored correctly end-to-end
    // (GET /api/channels deliberately hides the secret config).
    const et = await request.post(`/api/channels/${emailCh!.id}/test`);
    expect(et.ok(), `email channel test-send: ${et.status()}`).toBeTruthy();
    const msg = await waitForMessage({
      subjectIncludes: 'Test alert:',
      to: recipient,
      timeoutMs: 30_000,
    });
    expect(
      (msg.To ?? []).some((t) => t.Address?.toLowerCase() === recipient.toLowerCase()),
      'the imported recipient address actually received the mail',
    ).toBe(true);

    // Webhook: send a test → the spec-local catch-all must receive it at
    // the IMPORTED url, proving config.url persisted + dispatches.
    hooks.length = 0;
    const wt = await request.post(`/api/channels/${hookCh!.id}/test`);
    expect(wt.ok(), `webhook channel test-send: ${wt.status()}`).toBeTruthy();
    const deadline = Date.now() + 15_000;
    while (hooks.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(hooks.length, 'catch-all received the dispatch at the imported url').toBeGreaterThan(0);
    expect(hooks[0].url, 'dispatched to the imported path').toBe('/hook');
    expect(hooks[0].body, 'real alert payload delivered').toContain('oo-workers test alert');
  } finally {
    if (qaId) await deleteMonitorViaApi(request, 'qa', qaId);
    if (urlId) await deleteMonitorViaApi(request, 'url', urlId);
    for (const id of channelIds) await request.delete(`/api/channels/${id}`).catch(() => {});
    await clearMailpit().catch(() => {});
    await new Promise<void>((r) => server.close(() => r()));
  }
});
