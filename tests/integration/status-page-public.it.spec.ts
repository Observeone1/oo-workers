/**
 * GET /status/:slug — covers three regressions from the 2026-05-25 batch:
 *
 *  A. TLS monitors render their host:port, not the wrong qa_projects row of
 *     the same id (monitorMeta used to fall through to qa).
 *  B. Banner aggregation: an up + unknown mix reads "degraded", not the
 *     alarming "Status unknown".
 *  C. Operator's chosen theme rides on the oo-theme cookie → class on <html>
 *     (no inline style="" attribute).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { acquireRedisDb, startTestServer, connectDb } from './_harness.ts';

let redisCtx: Awaited<ReturnType<typeof acquireRedisDb>>;
let serverCtx: Awaited<ReturnType<typeof startTestServer>>;
let base = '';
let slug = '';
let sql: ReturnType<typeof connectDb>;

beforeAll(async () => {
  redisCtx = await acquireRedisDb();
  serverCtx = await startTestServer(redisCtx.redisUrl);
  base = serverCtx.url;
  sql = connectDb();

  slug = `sp-${Date.now()}`;

  const [tls] = await sql<[{ id: number }]>`
    INSERT INTO tls_monitors (name, host, port, warn_days)
    VALUES ('Edge cert', 'api.example.com', 8443, 30)
    RETURNING id`;
  const [url] = await sql<[{ id: number }]>`
    INSERT INTO url_monitors (name, url, timeout_ms, enabled)
    VALUES ('Healthy URL', 'https://example.com', 15000, FALSE)
    RETURNING id`;

  // URL monitor has a successful run; TLS monitor has nothing → "unknown".
  // That mix is what should produce the "degraded" banner.
  await sql`
    INSERT INTO url_monitor_executions (url_monitor_id, status)
    VALUES (${url.id}, 'SUCCESS')`;

  const [page] = await sql<[{ id: number }]>`
    INSERT INTO status_pages (slug, title) VALUES (${slug}, 'Test') RETURNING id`;
  await sql`
    INSERT INTO status_page_monitors (status_page_id, monitor_type, monitor_id, sort_order)
    VALUES (${page.id}, 'tls', ${tls.id}, 0),
           (${page.id}, 'url', ${url.id}, 1)`;
}, 60_000);

afterAll(async () => {
  await sql`DELETE FROM status_pages WHERE slug = ${slug}`.catch(() => {});
  await sql.end();
  await serverCtx.stop();
  await redisCtx.releaseDb();
}, 30_000);

describe('GET /status/:slug', () => {
  test('A. TLS monitor renders as TLS (host:port), not as a QA project', async () => {
    const html = await (await fetch(`${base}/status/${slug}`)).text();
    // Target from the TLS branch in monitorMeta.
    expect(html).toContain('api.example.com:8443');
    // Hard signal of the old fall-through: TLS monitors would render with
    // qa_projects target text. If that string ever reappears, the branch
    // has regressed.
    expect(html).not.toContain('browser script');
  });

  test('B. up + unknown mix → degraded banner, not unknown', async () => {
    const html = await (await fetch(`${base}/status/${slug}`)).text();
    expect(html).toContain('class="overall degraded"');
    expect(html).toContain('Some services are degraded');
    expect(html).not.toContain('class="overall unknown"');
  });

  test('C. no cookie → no theme class on <html>', async () => {
    const html = await (await fetch(`${base}/status/${slug}`)).text();
    expect(html).not.toContain('class="theme-dark"');
    expect(html).not.toContain('class="theme-light"');
    expect(html).not.toContain('style="color-scheme'); // no inline style fallback
  });

  test('C. oo-theme=dark cookie → class="theme-dark" on <html>', async () => {
    const html = await (
      await fetch(`${base}/status/${slug}`, { headers: { cookie: 'oo-theme=dark' } })
    ).text();
    expect(html).toContain('<html lang="en" class="theme-dark">');
  });

  test('C. oo-theme=light cookie → class="theme-light"', async () => {
    const html = await (
      await fetch(`${base}/status/${slug}`, { headers: { cookie: 'oo-theme=light' } })
    ).text();
    expect(html).toContain('<html lang="en" class="theme-light">');
  });

  test('C. bogus cookie value is ignored → no theme class', async () => {
    const html = await (
      await fetch(`${base}/status/${slug}`, { headers: { cookie: 'oo-theme=hacker' } })
    ).text();
    expect(html).not.toMatch(/class="theme-(light|dark)"/);
  });
});

// Projection test: stale PENDING execution on a status page monitor shows as 'down',
// not 'unknown'. The aggregator's currentStatus() checks start_time age against
// 2× interval_seconds — the same logic as exec-projection.ts.
describe('D. stale PENDING execution → down on public status page', () => {
  let slug2 = '';
  let urlId2 = -1;

  beforeAll(async () => {
    // sql, base, redisCtx, serverCtx are initialised by the outer beforeAll.
    slug2 = `sp-stall-${Date.now()}`;

    const [mon] = await sql<[{ id: number }]>`
      INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
      VALUES ('stall-proj', 'https://example.com', 15000, 60, FALSE)
      RETURNING id`;
    urlId2 = mon.id;

    // PENDING execution older than 2 × 60 = 120 s → aggregator must project as 'down'.
    const staleTime = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago
    await sql`
      INSERT INTO url_monitor_executions (url_monitor_id, status, start_time)
      VALUES (${urlId2}, 'PENDING', ${staleTime})`;

    const [pg] = await sql<[{ id: number }]>`
      INSERT INTO status_pages (slug, title) VALUES (${slug2}, 'Stall test') RETURNING id`;
    await sql`
      INSERT INTO status_page_monitors (status_page_id, monitor_type, monitor_id, sort_order)
      VALUES (${pg.id}, 'url', ${urlId2}, 0)`;
  }, 30_000);

  afterAll(async () => {
    await sql`DELETE FROM status_pages WHERE slug = ${slug2}`.catch(() => {});
    if (urlId2 > 0) await sql`DELETE FROM url_monitors WHERE id = ${urlId2}`.catch(() => {});
  }, 30_000);

  test('stale PENDING → monitor-status down, not unknown', async () => {
    const html = await (await fetch(`${base}/status/${slug2}`)).text();
    expect(html).toContain('class="monitor-status down"');
    expect(html).not.toContain('class="monitor-status unknown"');
  });

  test('overall banner is down when the only monitor is stale PENDING', async () => {
    const html = await (await fetch(`${base}/status/${slug2}`)).text();
    expect(html).toContain('class="overall down"');
  });
});
