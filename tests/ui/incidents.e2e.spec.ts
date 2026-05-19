import {
  test,
  expect,
  uniqueSuffix,
  ensureSessionAccount,
} from './fixtures';

/**
 * Real-path e2e for status-page incidents (v1.11.0). MANUAL only —
 * Playwright is not in CI by repo policy; scripts/incident-render-test.ts
 * is the CI gate for the markdown→HTML safety. This drives the operator
 * UI (create incident → post update → resolve) and asserts the actual
 * public /status/<slug> HTML: the incident renders, markdown works, and
 * an injected <script> is neutralised end-to-end (renderer + CSP).
 */

test('operator posts an incident; it renders + is XSS-safe on the public page', async ({
  page,
  request,
  shot,
}) => {
  test.setTimeout(120_000);
  if (!process.env.OO_E2E_API_KEY) {
    test.skip(
      !(await ensureSessionAccount(request)),
      'no usable auth — set OO_E2E_API_KEY or use a fresh stack',
    );
  }

  const suffix = uniqueSuffix();
  const slug = `inc-e2e-${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const title = `Checkout degraded ${suffix}`;
  const XSS = '<script>alert(1)</script>';
  let pageId = 0;

  // Status page to host the incident (incidents are page-scoped).
  const sp = await request.post('/api/status-pages', {
    data: { slug, title: `Incident E2E ${suffix}`, description: null },
  });
  expect(sp.ok(), `create status page: ${sp.status()} ${await sp.text()}`).toBeTruthy();
  pageId = (await sp.json()).id;

  try {
    // --- Create the incident through the operator UI ---
    await page.goto('/#/incidents');
    await page.waitForSelector('#incident-create-form', { timeout: 8000 });
    await page.locator('#inc-page').selectOption(String(pageId));
    await page.locator('#incident-create-form input[name="title"]').fill(title);
    await page
      .locator('#incident-create-form select[name="severity"]')
      .selectOption('investigating');
    // Body exercises the safe subset (**bold**) AND an injection attempt.
    await page
      .locator('#incident-create-form textarea[name="body"]')
      .fill(`We are **investigating**. ${XSS}`);
    await page.locator('#incident-create-form button[type="submit"]').click();

    // Lands in the editor; capture the new id from the hash.
    await page.waitForFunction(() => /#\/incidents\/\d+$/.test(location.hash), { timeout: 8000 });
    const hash = await page.evaluate(() => location.hash);
    const incId = Number(hash.split('/').pop());
    expect(incId).toBeGreaterThan(0);
    await page.waitForSelector('#incident-update-form', { timeout: 8000 });
    await shot('incident-editor');

    // --- Assert the PUBLIC page (no auth, server-rendered) ---
    const pub1 = await request.get(`/status/${slug}`);
    expect(pub1.ok()).toBeTruthy();
    expect(
      pub1.headers()['content-security-policy'] ?? '',
      'CSP must lock down scripts on the public page',
    ).toContain("script-src 'none'");
    const html1 = await pub1.text();
    expect(html1, 'incident title renders').toContain(title);
    expect(html1, 'severity pill renders').toContain('sev-investigating');
    expect(html1, '**bold** markdown is rendered').toContain('<strong>investigating</strong>');
    expect(html1, 'injected <script> must be escaped, never live').not.toContain(XSS);
    expect(html1, 'injected script shows as escaped text').toContain('&lt;script&gt;');

    // --- Post a resolving update through the UI ---
    await page
      .locator('#incident-update-form select[name="severity"]')
      .selectOption('resolved');
    await page
      .locator('#incident-update-form textarea[name="body"]')
      .fill('Root cause fixed. Back to normal.');
    await page.locator('#incident-update-form button[type="submit"]').click();
    await expect(page.locator('.banner-ok')).toContainText('resolved', { timeout: 8000 });

    // Resolved-within-24h still shows on the public page, now resolved.
    const pub2 = await request.get(`/status/${slug}`);
    const html2 = await pub2.text();
    expect(html2).toContain(title);
    expect(html2, 'now carries the resolved severity').toContain('sev-resolved');
    expect(html2).toContain('Root cause fixed.');

    // Public page screenshot (eyeballed, not just asserted).
    await page.goto(`/status/${slug}`);
    await page.waitForSelector('.incident', { timeout: 8000 });
    await shot('incident-public-page');
  } finally {
    // Deleting the status page cascades the incident + its updates.
    await request.delete(`/api/status-pages/${pageId}`).catch(() => {});
  }
});
