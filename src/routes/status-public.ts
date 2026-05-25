/**
 * GET /status/:slug — public, unauthenticated, server-rendered. Standalone
 * HTML (no SPA boot) so it works behind any proxy. CSP with
 * `script-src 'none'` is defence-in-depth: even a hole in
 * incident-render.ts can't execute injected script on this page.
 */
import type { Hono } from 'hono';
import { summarizeStatusPage } from '../services/status-page-aggregator.ts';
import { renderStatusPageHtml } from '../services/status-page-html.ts';

const STATUS_CSP =
  "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'";

function parseThemeCookie(header: string | undefined): 'light' | 'dark' | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === 'oo-theme' && (v === 'light' || v === 'dark')) return v;
  }
  return undefined;
}

export function registerStatusPublicRoutes(app: Hono): void {
  app.get('/status/:slug', async (c) => {
    const slug = c.req.param('slug');
    c.header('Content-Security-Policy', STATUS_CSP);
    const summary = await summarizeStatusPage(slug);
    if (!summary) {
      return c.html(
        '<!doctype html><html><body style="font:14px sans-serif;padding:48px;text-align:center"><h1>Not found</h1><p>No status page with that slug.</p></body></html>',
        404,
      );
    }
    const theme = parseThemeCookie(c.req.header('cookie'));
    return c.html(renderStatusPageHtml(summary, theme));
  });
}
