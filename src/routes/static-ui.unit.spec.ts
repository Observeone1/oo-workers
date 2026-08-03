import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { registerStaticRoutes } from './static-ui.ts';

const app = new Hono();
registerStaticRoutes(app);

const PUBLIC_DIR = resolve(import.meta.dir, '../../public');

const STUBS: Record<string, string> = {
  'index.html': '<!doctype html><title>oo-workers</title>',
  'app.js': 'console.log("stub")',
  'docs.html': '<!doctype html><main>docs</main>',
  'tokens.css': ':root{--stub:1}',
  'dashboard.css': '.stub{}',
  'docs.css': '.docs{}',
  'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
};

beforeAll(() => {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(PUBLIC_DIR, name), body);
  }
});

describe('static UI routes', () => {
  test('serves the built SPA assets with their content types', async () => {
    expect((await app.request('/')).status).toBe(200);
    expect((await app.request('/')).headers.get('content-type')).toMatch(/text\/html/);

    const js = await app.request('/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('application/javascript');

    expect((await app.request('/docs.html')).status).toBe(200);

    for (const css of ['/tokens.css', '/dashboard.css', '/docs.css']) {
      const response = await app.request(css);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/css');
    }

    const favicon = await app.request('/favicon.svg');
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get('content-type')).toBe('image/svg+xml');
  });

  test('redirects direct documentation requests into the SPA route', async () => {
    const response = await app.request('/docs');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/#/docs');
  });
});
