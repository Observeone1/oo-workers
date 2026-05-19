import { createServer, type Server } from 'node:http';
import { test, expect, waitForList, uniqueSuffix, deleteMonitorViaApi, ensureSessionAccount } from './fixtures';
import { mailpitReachable, clearMailpit, waitForMessage, assertNoMessage } from './mailpit';

/**
 * Full real-path e2e for QA-monitor-alerting (v1.10.0). MANUAL only —
 * Playwright is not in CI by repo policy; `scripts/qa-alerting-test.ts`
 * stays the CI gate (it calls the detector directly). This is the piece
 * that gate can't cover: run-now → BullMQ → real Playwright → per-run
 * aggregation → maybeAlertOnQaRunTransition → dispatchAlert → a real
 * email (asserted via Mailpit) + a real Discord webhook (fired live;
 * Discord has no read-back API so it is verified by eyeball — the test
 * prints exactly what to look for).
 *
 * Outcome is flipped via a local toggle server the QA script probes:
 * GET /state → 200 (pass) or 500 (fail). Two tests in the project so the
 * N-row per-run batch aggregation is exercised.
 *
 * Sequence: pass (baseline, first-run → no alert) → fail (up→down →
 * outage email) → fail (down→down → NO new email) → pass (down→up →
 * recovery email). The two no-email assertions are the anti-vacuous
 * controls: a stuck-open dispatch wrongly delivers there.
 *
 * Prereq: dev stack on :3010 with the worker running + Mailpit up
 * (start-oo-workers.sh launches it). Visible skip (yellow, not green)
 * if auth or Mailpit is unavailable.
 */

test('QA monitor fires email (Mailpit) + Discord on outage and recovery', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(600_000); // 4 real Playwright runs incl. cold start

  // Auth: a Bearer key (config extraHTTPHeaders) covers the `request`
  // writes; only fall back to a cookie session when no key is set —
  // skip only if neither works (mirrors tcp-banner.e2e.spec.ts).
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

  await clearMailpit();

  // Toggle server: the QA script GETs /state; 200 = pass, 500 = fail.
  let state: 'pass' | 'fail' = 'pass';
  const server: Server = createServer((req, res) => {
    if (req.url === '/state') {
      res.writeHead(state === 'pass' ? 200 : 500, { 'content-type': 'text/plain' }).end(state);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  expect(port, 'toggle server failed to bind').toBeGreaterThan(0);

  const suffix = uniqueSuffix();
  const recipient = `qa-e2e+${suffix}@example.com`;
  const projName = `qa-e2e-alerting-${suffix}`;
  const channelIds: number[] = [];
  let projectId = 0;
  // Discord is a required leg of the full e2e (it has no read-back API,
  // so you verify it by eyeball). A missing webhook is a hard FAIL, not
  // a skip — unlike auth/Mailpit which are environment-not-ready skips.
  const discordUrl = process.env.OO_E2E_DISCORD_WEBHOOK;
  if (!discordUrl) {
    throw new Error(
      'OO_E2E_DISCORD_WEBHOOK is required: the full QA-alerting e2e must fire ' +
        'Discord too. Set it to your incoming-webhook URL and re-run.',
    );
  }

  try {
    // --- email channel (asserted via Mailpit) ---
    const ec = await request.post('/api/channels', {
      data: { name: `qa-e2e-email-${suffix}`, type: 'email', url: recipient },
    });
    expect(ec.ok(), `create email channel: ${ec.status()}`).toBeTruthy();
    channelIds.push((await ec.json()).id);

    // --- discord channel (fired live; verified by eyeball) ---
    const dc = await request.post('/api/channels', {
      data: { name: `qa-e2e-discord-${suffix}`, type: 'discord', url: discordUrl },
    });
    expect(dc.ok(), `create discord channel: ${dc.status()}`).toBeTruthy();
    channelIds.push((await dc.json()).id);

    // --- QA project: enabled:false so the scheduler never injects a
    // rogue run that poisons the detector's ±30s previous-run bucket;
    // run-now ignores `enabled`. Huge interval as belt-and-suspenders.
    // Two tests so the per-run N-row aggregation is exercised. ---
    const stable = `import { test, expect } from '@playwright/test';
test('t-stable', async () => { expect(1 + 1).toBe(2); });
`;
    const toggle = `import { test, expect } from '@playwright/test';
test('t-toggle', async ({ request }) => {
  const r = await request.get('http://127.0.0.1:${port}/state');
  expect(r.status()).toBe(200);
});
`;
    const pc = await request.post('/api/monitors/qa', {
      data: {
        name: projName,
        targetUrl: `http://127.0.0.1:${port}`,
        intervalSeconds: 86_400,
        enabled: false,
        tests: [
          { name: 't-stable', script: stable },
          { name: 't-toggle', script: toggle },
        ],
      },
    });
    expect(pc.ok(), `create QA project: ${pc.status()} ${await pc.text()}`).toBeTruthy();
    projectId = (await pc.json()).id;

    const bind = await request.put(`/api/monitors/qa/${projectId}/channels`, {
      data: { channelIds },
    });
    expect(bind.ok(), `bind channels: ${bind.status()}`).toBeTruthy();

    // Trigger run #n and block until its 2-row batch is fully settled
    // (no row 'running' AND ≥ 2*n settled rows), so the next run's
    // anchor sees a complete prior run. Then pause so consecutive
    // startedAt values are ordered vs the detector's lt(runStartTime).
    let runNo = 0;
    async function runOnce(label: string) {
      runNo += 1;
      const r = await request.post(`/api/monitors/qa/${projectId}/run`);
      expect(r.ok(), `${label}: run trigger ${r.status()}`).toBeTruthy();
      let settled = false;
      for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(2000);
        const body = (await (await request.get(`/api/monitors/qa/${projectId}`)).json()) as {
          runs: Array<{ status: string }>;
        };
        const running = body.runs.some((x) => x.status === 'running');
        const done = body.runs.filter(
          (x) => x.status === 'passed' || x.status === 'failed' || x.status === 'error',
        ).length;
        if (!running && done >= runNo * 2) {
          settled = true;
          break;
        }
      }
      expect(settled, `${label}: run did not settle in 180s`).toBeTruthy();
      await page.waitForTimeout(2000);
    }

    const DOWN = `[oo-workers] DOWN: ${projName}`;
    const RECOVERED = `[oo-workers] Recovered: ${projName}`;

    // 1) baseline PASS — detector first-run (no anchor) → no alert.
    state = 'pass';
    await runOnce('baseline pass');
    await assertNoMessage({ to: recipient, windowMs: 6000 });

    // 2) FAIL — up→down → outage email.
    state = 'fail';
    await runOnce('fail #1 (up→down)');
    const downMsg = await waitForMessage({ subjectIncludes: DOWN, to: recipient, timeoutMs: 30_000 });
    expect(downMsg.To.some((t) => t.Address.toLowerCase() === recipient)).toBeTruthy();
    expect(`${downMsg.Text ?? ''}${downMsg.HTML ?? ''}`).toContain(projName);

    // UI: the QA monitor should now read red.
    await page.goto('/');
    await waitForList(page);
    await page.locator('.tab[data-tab="qa"]').click();
    await expect(page.locator('tr[data-type="qa"]', { hasText: projName })).toBeVisible({
      timeout: 5000,
    });
    await shot('qa-alerting-down');

    // 3) FAIL again — down→down → NO new email (anti-vacuous).
    await clearMailpit();
    state = 'fail';
    await runOnce('fail #2 (down→down noop)');
    await assertNoMessage({ to: recipient, windowMs: 8000 });

    // 4) PASS — down→up → recovery email.
    state = 'pass';
    await runOnce('recovery pass (down→up)');
    const recMsg = await waitForMessage({
      subjectIncludes: RECOVERED,
      to: recipient,
      timeoutMs: 30_000,
    });
    expect(recMsg.To.some((t) => t.Address.toLowerCase() === recipient)).toBeTruthy();

    await page.goto('/');
    await waitForList(page);
    await page.locator('.tab[data-tab="qa"]').click();
    await expect(page.locator('tr[data-type="qa"]', { hasText: projName })).toBeVisible({
      timeout: 5000,
    });
    await shot('qa-alerting-recovered');

    console.warn(
      '\n────────────────────────────────────────────────────────────\n' +
        '→ CHECK YOUR DISCORD now. You should see, for monitor\n' +
        `  "${projName}":\n` +
        '    1. an OUTAGE embed (red) — fired on fail #1\n' +
        '    2. a RECOVERY embed (green) — fired on the final pass\n' +
        '  (down→down fired nothing; baseline fired nothing.)\n' +
        '────────────────────────────────────────────────────────────\n',
    );
  } finally {
    if (projectId) await deleteMonitorViaApi(request, 'qa', projectId);
    for (const id of channelIds) {
      await request.delete(`/api/channels/${id}`).catch(() => {});
    }
    await clearMailpit();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
