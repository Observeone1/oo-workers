/**
 * /api/status-pages HTTP contract — driven through a real Hono app via
 * app.request(): slug/title validation, slug uniqueness, the page+monitors
 * detail view, patch semantics, and the full-replace monitor binding
 * endpoint with per-entry validation. Repos are mocked at the db boundary.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

import {
  mockStatusPageRepo,
  statusPageMonitorRepoMock as monitorRepo,
  statusPageRepoMock as pageRepo,
} from '../test-support/shared-mocks.ts';

mockStatusPageRepo();

const { registerStatusPageRoutes } = await import('./status-pages.ts');

function makeApp(): Hono {
  const app = new Hono();
  registerStatusPageRoutes(app);
  return app;
}

beforeEach(() => {
  for (const m of Object.values(pageRepo)) m.mockReset();
  for (const m of Object.values(monitorRepo)) m.mockReset();
  pageRepo.list.mockResolvedValue([]);
  pageRepo.findBySlug.mockResolvedValue(null);
  pageRepo.findById.mockResolvedValue(null);
  pageRepo.create.mockImplementation(async (v: Record<string, unknown>) => [{ id: 4, ...v }]);
  monitorRepo.forPage.mockResolvedValue([]);
});

describe('POST /api/status-pages', () => {
  const post = (body: unknown) =>
    makeApp().request('/api/status-pages', { method: 'POST', body: JSON.stringify(body) });

  test.each(['UPPER', '-x', '', 'a'.repeat(70)])('rejects the slug %j', async (slug) => {
    const res = await post({ slug, title: 'T' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('slug must be');
  });

  test('requires a title', async () => {
    const res = await post({ slug: 'public', title: '   ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'title is required' });
  });

  test('rejects a taken slug with 409', async () => {
    pageRepo.findBySlug.mockResolvedValue({ id: 1, slug: 'public' });
    const res = await post({ slug: 'public', title: 'Public' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "slug 'public' is already taken" });
  });

  test('creates a page, trimming inputs and blank description to null', async () => {
    const res = await post({ slug: ' public ', title: ' Public ', description: '  ' });

    expect(res.status).toBe(201);
    expect(pageRepo.create).toHaveBeenCalledWith({
      slug: 'public',
      title: 'Public',
      description: null,
    });
    expect(await res.json()).toMatchObject({ id: 4, slug: 'public' });
  });
});

describe('GET /api/status-pages/:id', () => {
  test('returns the page with its bound monitors', async () => {
    pageRepo.findById.mockResolvedValue({ id: 4, slug: 'public', title: 'Public' });
    monitorRepo.forPage.mockResolvedValue([{ monitorType: 'url', monitorId: 7 }]);

    const res = await makeApp().request('/api/status-pages/4');
    expect(await res.json()).toEqual({
      id: 4,
      slug: 'public',
      title: 'Public',
      monitors: [{ monitorType: 'url', monitorId: 7 }],
    });
  });

  test('404 for a missing page, 400 for a bad id', async () => {
    expect((await makeApp().request('/api/status-pages/9')).status).toBe(404);
    expect((await makeApp().request('/api/status-pages/x')).status).toBe(400);
  });
});

describe('PATCH /api/status-pages/:id', () => {
  const patch = (id: string, body: unknown) =>
    makeApp().request(`/api/status-pages/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

  test('rejects an empty patch', async () => {
    const res = await patch('4', { irrelevant: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'no fields to update' });
  });

  test('updates only the provided fields', async () => {
    const res = await patch('4', { title: ' New title ', description: '' });
    expect(res.status).toBe(204);
    expect(pageRepo.update).toHaveBeenCalledWith(4, {
      title: 'New title',
      description: null,
    });
  });
});

describe('PUT /api/status-pages/:id/monitors', () => {
  const put = (body: unknown) =>
    makeApp().request('/api/status-pages/4/monitors', {
      method: 'PUT',
      body: JSON.stringify(body),
    });

  test('requires a monitors array', async () => {
    const res = await put({ monitors: 'nope' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'monitors must be an array of {type, id}' });
  });

  test.each([[{ type: 'cron', id: 1 }], [{ type: 'url', id: 1.5 }], [{ type: 'url' }]])(
    'rejects the bad entry %j',
    async (entry) => {
      const res = await put({ monitors: [entry] });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('bad monitor entry');
      expect(monitorRepo.set).not.toHaveBeenCalled();
    },
  );

  test('replaces the full binding set preserving array order', async () => {
    const res = await put({
      monitors: [
        { type: 'url', id: 7 },
        { type: 'tls', id: 2 },
      ],
    });

    const bindings = [
      { monitorType: 'url', monitorId: 7 },
      { monitorType: 'tls', monitorId: 2 },
    ];
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, monitors: bindings });
    expect(monitorRepo.set).toHaveBeenCalledWith(4, bindings);
  });
});

describe('DELETE /api/status-pages/:id', () => {
  test('deletes and returns 204', async () => {
    const res = await makeApp().request('/api/status-pages/4', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(pageRepo.deleteById).toHaveBeenCalledWith(4);
  });
});
