/**
 * /api/incidents HTTP contract — driven through a real Hono app via
 * app.request(): the status_page_id + filter listing, incident creation
 * against an existing page, the update thread, title patching and
 * deletion. Repos are mocked at the db boundary.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const incidentRepo = {
  listForPage: mock(async (_id: number, _f: string): Promise<unknown[]> => []),
  create: mock(async (_v: Record<string, unknown>): Promise<unknown> => ({})),
  findById: mock(async (_id: number): Promise<unknown> => null),
  addUpdate: mock(async (_id: number, _v: Record<string, unknown>): Promise<unknown> => null),
  updateTitle: mock(async (_id: number, _t: string): Promise<void> => {}),
  deleteById: mock(async (_id: number): Promise<void> => {}),
};
const findById = mock(async (_id: number): Promise<unknown> => null);

const SEVERITIES = ['investigating', 'identified', 'monitoring', 'resolved'] as const;

mock.module('../db/repositories/incident.repo.ts', () => ({
  incidentRepo,
  SEVERITIES,
}));
mock.module('../db/repositories/status-page.repo.ts', () => ({
  statusPageRepo: { findById },
}));

const { registerIncidentRoutes } = await import('./incidents.ts');

function makeApp(): Hono {
  const app = new Hono();
  registerIncidentRoutes(app);
  return app;
}

beforeEach(() => {
  for (const m of Object.values(incidentRepo)) m.mockReset();
  findById.mockReset();
  incidentRepo.listForPage.mockResolvedValue([]);
  incidentRepo.findById.mockResolvedValue(null);
  incidentRepo.addUpdate.mockResolvedValue(null);
  findById.mockResolvedValue({ id: 4 });
});

describe('GET /api/incidents', () => {
  test('requires status_page_id', async () => {
    const res = await makeApp().request('/api/incidents');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'status_page_id required' });
  });

  test('passes the filter through, defaulting unknown values to all', async () => {
    await makeApp().request('/api/incidents?status_page_id=4&filter=active');
    expect(incidentRepo.listForPage).toHaveBeenLastCalledWith(4, 'active');

    await makeApp().request('/api/incidents?status_page_id=4&filter=bogus');
    expect(incidentRepo.listForPage).toHaveBeenLastCalledWith(4, 'all');
  });
});

describe('POST /api/incidents', () => {
  const post = (body: unknown) =>
    makeApp().request('/api/incidents', { method: 'POST', body: JSON.stringify(body) });

  const valid = {
    status_page_id: 4,
    title: 'Elevated error rates',
    severity: 'investigating',
    body: 'We are looking into it.',
  };

  test.each([
    [{ ...valid, status_page_id: 'x' }, 'status_page_id required'],
    [{ ...valid, title: ' ' }, 'title is required'],
    [{ ...valid, body: '' }, 'body is required'],
    [
      { ...valid, severity: 'catastrophic' },
      'severity must be one of investigating, identified, monitoring, resolved',
    ],
  ])('rejects %j', async (body, error) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
    expect(incidentRepo.create).not.toHaveBeenCalled();
  });

  test('404s when the status page does not exist', async () => {
    findById.mockResolvedValue(null);
    const res = await post(valid);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'status page not found' });
  });

  test('creates the incident with trimmed fields', async () => {
    incidentRepo.create.mockResolvedValue({ id: 11, title: 'Elevated error rates' });

    const res = await post({ ...valid, title: ' Elevated error rates ' });
    expect(res.status).toBe(201);
    expect(incidentRepo.create).toHaveBeenCalledWith({
      statusPageId: 4,
      title: 'Elevated error rates',
      severity: 'investigating',
      body: 'We are looking into it.',
    });
  });

  test('accepts the camelCase statusPageId alias', async () => {
    incidentRepo.create.mockResolvedValue({ id: 12 });
    const res = await post({ ...valid, status_page_id: undefined, statusPageId: 4 });
    expect(res.status).toBe(201);
  });
});

describe('GET /api/incidents/:id', () => {
  test('returns the incident thread or 404', async () => {
    incidentRepo.findById.mockResolvedValue({ id: 11, updates: [] });
    expect(await (await makeApp().request('/api/incidents/11')).json()).toEqual({
      id: 11,
      updates: [],
    });

    incidentRepo.findById.mockResolvedValue(null);
    expect((await makeApp().request('/api/incidents/11')).status).toBe(404);
  });
});

describe('POST /api/incidents/:id/updates', () => {
  const post = (body: unknown) =>
    makeApp().request('/api/incidents/11/updates', {
      method: 'POST',
      body: JSON.stringify(body),
    });

  test('validates body and severity', async () => {
    expect((await post({ severity: 'identified' })).status).toBe(400);
    expect((await post({ body: 'x', severity: 'nope' })).status).toBe(400);
  });

  test('appends an update and 404s for unknown incidents', async () => {
    incidentRepo.addUpdate.mockResolvedValue({ id: 21, severity: 'monitoring' });
    const ok = await post({ body: ' Fix deployed ', severity: 'monitoring' });
    expect(ok.status).toBe(201);
    expect(incidentRepo.addUpdate).toHaveBeenCalledWith(11, {
      severity: 'monitoring',
      body: 'Fix deployed',
    });

    incidentRepo.addUpdate.mockResolvedValue(null);
    expect((await post({ body: 'x', severity: 'resolved' })).status).toBe(404);
  });
});

describe('PATCH + DELETE /api/incidents/:id', () => {
  test('renames an incident', async () => {
    const res = await makeApp().request('/api/incidents/11', {
      method: 'PATCH',
      body: JSON.stringify({ title: ' New title ' }),
    });
    expect(res.status).toBe(204);
    expect(incidentRepo.updateTitle).toHaveBeenCalledWith(11, 'New title');
  });

  test('rejects an empty title', async () => {
    const res = await makeApp().request('/api/incidents/11', {
      method: 'PATCH',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test('deletes an incident', async () => {
    const res = await makeApp().request('/api/incidents/11', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(incidentRepo.deleteById).toHaveBeenCalledWith(11);
  });
});
