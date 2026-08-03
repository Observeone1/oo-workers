/**
 * Incident repository contract.
 *
 * The route tests mock the repository. This covers the transactional incident
 * lifecycle and the public active/recently-resolved projection against Postgres.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connectDb } from './_harness.ts';
import { incidentRepo } from '../../src/db/repositories/incident.repo.ts';

const sql = connectDb();
const marker = `incidents-repo-it-${Date.now()}`;
let statusPageId = -1;
let activeId = -1;
let resolvedId = -1;

beforeAll(async () => {
  const [page] = await sql<[{ id: number }]>`
    INSERT INTO status_pages (slug, title)
    VALUES (${marker}, 'Incident repository integration test')
    RETURNING id
  `;
  statusPageId = page.id;
}, 30_000);

afterAll(async () => {
  if (statusPageId > 0) {
    await sql`DELETE FROM status_pages WHERE id = ${statusPageId}`;
  }
  await sql.end();
});

describe('incidentRepo', () => {
  test('creates a thread, appends updates, and projects public incidents', async () => {
    const active = await incidentRepo.create({
      statusPageId,
      title: 'Active incident',
      severity: 'investigating',
      body: 'Investigating the issue.',
    });
    activeId = active.id;

    const update = await incidentRepo.addUpdate(active.id, {
      severity: 'identified',
      body: 'Root cause identified.',
    });
    expect(update?.severity).toBe('identified');

    const resolved = await incidentRepo.create({
      statusPageId,
      title: 'Recently resolved incident',
      severity: 'resolved',
      body: 'Resolved within the last day.',
    });
    resolvedId = resolved.id;

    const publicIncidents = await incidentRepo.forPublic(statusPageId);
    expect(publicIncidents.map((incident) => incident.id)).toEqual([active.id, resolved.id]);
    expect(publicIncidents[0]?.updates.map((item) => item.severity)).toEqual([
      'investigating',
      'identified',
    ]);
    expect(publicIncidents[1]?.updates).toHaveLength(1);
  });

  test('lists active and resolved incidents separately and handles missing updates', async () => {
    const active = await incidentRepo.listForPage(statusPageId, 'active');
    const resolved = await incidentRepo.listForPage(statusPageId, 'resolved');
    const all = await incidentRepo.listForPage(statusPageId);

    expect(active.some((incident) => incident.id === activeId)).toBe(true);
    expect(active.some((incident) => incident.id === resolvedId)).toBe(false);
    expect(resolved.some((incident) => incident.id === resolvedId)).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(await incidentRepo.findById(-1)).toBeNull();
    expect(await incidentRepo.addUpdate(-1, { severity: 'monitoring', body: 'missing' })).toBeNull();
  });
});
