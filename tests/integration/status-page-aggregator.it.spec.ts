/**
 * summarizeStatusPage — the two branches status-page-public.it.spec.ts
 * doesn't reach: normalize() resolving a non-stale FAILED execution to
 * 'down' and a non-stale PENDING one to 'unknown' (that spec only covers
 * the "no execution" and "stale PENDING" projections), and the public
 * incident mapping (active + recently-resolved, with updates).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { summarizeStatusPage } from '../../src/services/status-page-aggregator.ts';
import { incidentRepo } from '../../src/db/repositories/incident.repo.ts';

const sql = connectDb();
const slug = `sp-agg-it-${Date.now()}`;
let pageId = -1;
let failedMonitorId = -1;
let pendingMonitorId = -1;
let activeIncidentId = -1;
let resolvedIncidentId = -1;

beforeAll(async () => {
  const [failedMon] = await sql<[{ id: number }]>`
    INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
    VALUES ('Failing service', 'https://down.example.com', 15000, 3600, FALSE)
    RETURNING id`;
  failedMonitorId = failedMon.id;
  // Fresh (not stale) FAILED execution — normalize() must resolve this to
  // 'down' directly, not via the stale-PENDING projection path.
  await sql`
    INSERT INTO url_monitor_executions (url_monitor_id, status, start_time)
    VALUES (${failedMonitorId}, 'FAILED', NOW())`;

  const [pendingMon] = await sql<[{ id: number }]>`
    INSERT INTO url_monitors (name, url, timeout_ms, interval_seconds, enabled)
    VALUES ('Mid-check service', 'https://pending.example.com', 15000, 3600, FALSE)
    RETURNING id`;
  pendingMonitorId = pendingMon.id;
  // Fresh (not stale — well within 2x interval_seconds) PENDING execution —
  // normalize() must fall through to 'unknown', not project it as 'down'.
  await sql`
    INSERT INTO url_monitor_executions (url_monitor_id, status, start_time)
    VALUES (${pendingMonitorId}, 'PENDING', NOW())`;

  const [page] = await sql<[{ id: number }]>`
    INSERT INTO status_pages (slug, title) VALUES (${slug}, 'Aggregator IT test') RETURNING id`;
  pageId = page.id;
  await sql`
    INSERT INTO status_page_monitors (status_page_id, monitor_type, monitor_id, sort_order)
    VALUES (${pageId}, 'url', ${failedMonitorId}, 0),
           (${pageId}, 'url', ${pendingMonitorId}, 1)`;

  const active = await incidentRepo.create({
    statusPageId: pageId,
    title: 'Ongoing incident',
    severity: 'investigating',
    body: 'Looking into it.',
  });
  activeIncidentId = active.id;
  await incidentRepo.addUpdate(active.id, { severity: 'monitoring', body: 'Still watching.' });

  const resolved = await incidentRepo.create({
    statusPageId: pageId,
    title: 'Fixed incident',
    severity: 'resolved',
    body: 'All good now.',
  });
  resolvedIncidentId = resolved.id;
}, 30_000);

afterAll(async () => {
  if (pageId > 0) await sql`DELETE FROM status_pages WHERE id = ${pageId}`.catch(() => {});
  if (failedMonitorId > 0) await sql`DELETE FROM url_monitors WHERE id = ${failedMonitorId}`.catch(() => {});
  if (pendingMonitorId > 0) await sql`DELETE FROM url_monitors WHERE id = ${pendingMonitorId}`.catch(() => {});
  await sql.end();
});

describe('summarizeStatusPage', () => {
  test('normalize() resolves a fresh FAILED execution to down and a fresh PENDING one to unknown', async () => {
    const summary = await summarizeStatusPage(slug);

    const failed = summary?.monitors.find((m) => m.id === failedMonitorId);
    const pending = summary?.monitors.find((m) => m.id === pendingMonitorId);
    expect(failed?.currentStatus).toBe('down');
    expect(pending?.currentStatus).toBe('unknown');
    expect(summary?.overall).toBe('down');
  });

  test('maps active and recently-resolved incidents with their updates', async () => {
    const summary = await summarizeStatusPage(slug);

    expect(summary?.incidents).toHaveLength(2);
    const active = summary?.incidents.find((i) => i.id === activeIncidentId);
    const resolved = summary?.incidents.find((i) => i.id === resolvedIncidentId);

    expect(active).toMatchObject({ title: 'Ongoing incident', severity: 'monitoring', resolvedAt: null });
    expect(active?.updates.map((u) => u.severity)).toEqual(['investigating', 'monitoring']);
    expect(typeof active?.updates[0]?.createdAt).toBe('string');

    expect(resolved?.title).toBe('Fixed incident');
    expect(typeof resolved?.resolvedAt).toBe('string');
  });
});
