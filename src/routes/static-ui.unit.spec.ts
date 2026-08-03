import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { registerStaticRoutes } from './static-ui.ts';

const app = new Hono();
registerStaticRoutes(app);

describe('static UI routes', () => {
  test('serves the built SPA assets with their content types', async () => {
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/app.js')).status).toBe(200);
    expect((await app.request('/docs.html')).status).toBe(200);
    expect((await app.request('/tokens.css')).status).toBe(200);
    expect((await app.request('/dashboard.css')).status).toBe(200);
    expect((await app.request('/docs.css')).status).toBe(200);
    expect((await app.request('/favicon.svg')).status).toBe(404);
  });

  test('redirects direct documentation requests into the SPA route', async () => {
    const response = await app.request('/docs');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/#/docs');
  });
});
