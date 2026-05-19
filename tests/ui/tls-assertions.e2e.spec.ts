import { test, expect, uniqueSuffix, deleteMonitorViaApi, ensureSessionAccount } from './fixtures';

/**
 * Real-path e2e for the 0018 opt-in TLS assertions (v1.14.0). MANUAL
 * only (repo policy); scripts/tls-cert-test.ts is the CI gate for the
 * PROBE logic. This pins the two things the pure gate can't:
 *
 *  1. the POST /api/monitors/tls regex validation actually rejects
 *     (denylist / length cap / invalid) with 400 — a validator never
 *     exercised gets silently weakened;
 *  2. the new columns survive the create→read round-trip
 *     (verify_chain/verify_hostname/expect_cn_regex come back on
 *     GET /api/monitors/tls/:id) — the ImportResult-missing-channels
 *     bug class, explicitly closed.
 *
 * Prereq: dev stack on :3010. Visible-yellow skip — never silent-green
 * — if auth is unavailable.
 */

test('TLS assertions: endpoint validates the regex, and the new columns round-trip', async ({
  request,
}) => {
  if (!process.env.OO_E2E_API_KEY) {
    test.skip(
      !(await ensureSessionAccount(request)),
      'no usable auth — set OO_E2E_API_KEY or use a fresh stack',
    );
  }

  const sfx = uniqueSuffix();
  const base = { host: 'example.com', port: 443, intervalSeconds: 3600, enabled: false };

  // 1. The endpoint must REJECT bad regexes (validator bites).
  const nested = await request.post('/api/monitors/tls', {
    data: { ...base, name: `tls-bad-nested-${sfx}`, expectCnRegex: '(a+)+' },
  });
  expect(nested.status(), 'trivially-nested quantifier → 400').toBe(400);

  const tooLong = await request.post('/api/monitors/tls', {
    data: { ...base, name: `tls-bad-long-${sfx}`, expectCnRegex: 'a'.repeat(201) },
  });
  expect(tooLong.status(), 'over 200 chars → 400').toBe(400);

  const invalid = await request.post('/api/monitors/tls', {
    data: { ...base, name: `tls-bad-invalid-${sfx}`, expectCnRegex: '(' },
  });
  expect(invalid.status(), 'uncompilable regex → 400').toBe(400);

  // 2. A valid monitor with all three knobs set → 201, then the values
  //    must come back on the detail read (no silent column loss).
  let id = 0;
  try {
    const ok = await request.post('/api/monitors/tls', {
      data: {
        ...base,
        name: `tls-ok-${sfx}`,
        verifyChain: true,
        verifyHostname: true,
        expectCnRegex: '^.*\\.example\\.com$',
      },
    });
    expect(ok.status(), `valid create → 201 (${await ok.text()})`).toBe(201);
    id = (await ok.json()).id;
    expect(id, 'created id returned').toBeGreaterThan(0);

    const detail = await (await request.get(`/api/monitors/tls/${id}`)).json();
    expect(detail.monitor.verifyChain, 'verify_chain round-trips').toBe(true);
    expect(detail.monitor.verifyHostname, 'verify_hostname round-trips').toBe(true);
    expect(detail.monitor.expectCnRegex, 'expect_cn_regex round-trips').toBe(
      '^.*\\.example\\.com$',
    );

    // Default-off must remain the shape for a plain monitor (no regression).
    const plain = await request.post('/api/monitors/tls', {
      data: { ...base, name: `tls-plain-${sfx}` },
    });
    expect(plain.status()).toBe(201);
    const plainId = (await plain.json()).id;
    const plainDetail = await (await request.get(`/api/monitors/tls/${plainId}`)).json();
    expect(plainDetail.monitor.verifyChain, 'defaults off').toBe(false);
    expect(plainDetail.monitor.verifyHostname, 'defaults off').toBe(false);
    expect(plainDetail.monitor.expectCnRegex, 'defaults null').toBeNull();
    await deleteMonitorViaApi(request, 'tls', plainId);
  } finally {
    if (id) await deleteMonitorViaApi(request, 'tls', id);
  }
});
