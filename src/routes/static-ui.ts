/**
 * Static UI assets — index.html, app.js, docs.html, *.css.
 *
 * Re-reads from disk on every request rather than caching at boot.
 * `bun build` rebuilds of public/app.js are otherwise invisible until
 * the server restarts (surprising in dev, silently masks UI changes).
 * The OS file cache keeps this fast; for prod the host's reverse proxy
 * typically takes over caching anyway.
 */
import type { Hono, Context } from 'hono';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const PUBLIC_DIR = resolve(import.meta.dir, '../../public');

function loadText(name: string): string | null {
  const p = join(PUBLIC_DIR, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

const serveCss = (name: string) => (c: Context) => {
  const body = loadText(name);
  return body
    ? c.body(body, 200, { 'content-type': 'text/css' })
    : c.text('/* not built */', 404);
};

export function registerStaticRoutes(app: Hono): void {
  app.get('/', (c) => {
    const html = loadText('index.html');
    return html ? c.html(html) : c.text('UI not built — run `bun run build:ui`', 500);
  });
  app.get('/app.js', (c) => {
    const js = loadText('app.js');
    return js
      ? c.body(js, 200, { 'content-type': 'application/javascript' })
      : c.text('// not built', 404);
  });
  app.get('/docs', (c) => {
    const html = loadText('docs.html');
    return html ? c.html(html) : c.text('docs not built', 500);
  });
  app.get('/tokens.css', serveCss('tokens.css'));
  app.get('/dashboard.css', serveCss('dashboard.css'));
  app.get('/docs.css', serveCss('docs.css'));
}
