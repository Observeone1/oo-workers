/**
 * Pure-function render tests for the public status page. Focused on the
 * timeline-expand control polish (P3 from 2026-05-25): the dim 12px
 * "Full timeline (N updates)" link is now a chevroned button.
 *
 * Network/DB-side assertions live in
 * tests/integration/status-page-public.it.spec.ts.
 */

import { describe, test, expect } from 'bun:test';
import { renderStatusPageHtml } from './status-page-html.ts';
import type { StatusPageSummary } from './status-page-aggregator.ts';

function baseSummary(overrides: Partial<StatusPageSummary> = {}): StatusPageSummary {
  return {
    page: { slug: 'x', title: 'X', description: null },
    monitors: [],
    incidents: [],
    overall: 'up',
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('renderStatusPageHtml — incident timeline expand control', () => {
  test('multi-update incident emits <details>+<summary> with chevron CSS', () => {
    const html = renderStatusPageHtml(
      baseSummary({
        incidents: [
          {
            id: 1,
            title: 'API outage',
            severity: 'investigating',
            resolvedAt: null,
            updates: [
              { severity: 'investigating', body: 'Looking', createdAt: new Date().toISOString() },
              { severity: 'identified', body: 'Found it', createdAt: new Date().toISOString() },
              { severity: 'monitoring', body: 'Patching', createdAt: new Date().toISOString() },
            ],
          },
        ],
      }),
    );

    // Disclosure pattern: <details><summary>Full timeline (3 updates)</summary>
    expect(html).toContain('<details>');
    expect(html).toContain('<summary>Full timeline (3 updates)</summary>');

    // Chevron rule + rotation on [open] must ship — that's the actual
    // visual fix. Pre-fix the summary was a 12px muted text link with
    // no marker and no rotation.
    expect(html).toContain('.incident summary::before');
    expect(html).toContain('.incident details[open] summary::before');
  });

  test('single-update incident has no expand control', () => {
    const html = renderStatusPageHtml(
      baseSummary({
        incidents: [
          {
            id: 2,
            title: 'Brief blip',
            severity: 'resolved',
            resolvedAt: new Date().toISOString(),
            updates: [{ severity: 'resolved', body: 'Fixed', createdAt: new Date().toISOString() }],
          },
        ],
      }),
    );

    expect(html).not.toContain('<summary>Full timeline');
  });

  test('unknown incident severity falls back to "investigating" styling', () => {
    const html = renderStatusPageHtml(
      baseSummary({
        incidents: [
          {
            id: 3,
            title: 'Weird severity',
            severity: 'not-a-real-severity',
            resolvedAt: null,
            updates: [
              {
                severity: 'not-a-real-severity',
                body: 'huh',
                createdAt: new Date().toISOString(),
              },
            ],
          },
        ],
      }),
    );
    expect(html).toContain('incident sev-investigating');
    expect(html).toContain('sev-pill sev-investigating');
  });

  test('incident with no updates renders without a "latest" block', () => {
    const html = renderStatusPageHtml(
      baseSummary({
        incidents: [
          {
            id: 4,
            title: 'No updates yet',
            severity: 'investigating',
            resolvedAt: null,
            updates: [],
          },
        ],
      }),
    );
    expect(html).toContain('No updates yet');
    expect(html).not.toContain('upd-body latest');
  });
});

describe('renderStatusPageHtml — overall status headline', () => {
  test('down renders the degraded headline with a fire emoji', () => {
    const html = renderStatusPageHtml(baseSummary({ overall: 'down' }));
    expect(html).toContain('Some services are degraded');
    expect(html).toContain('🔥');
    expect(html).toContain('overall down');
  });

  test('degraded renders the degraded headline with a warning emoji', () => {
    const html = renderStatusPageHtml(baseSummary({ overall: 'degraded' }));
    expect(html).toContain('Some services are degraded');
    expect(html).toContain('⚠️');
    expect(html).toContain('overall degraded');
  });

  test('up renders the all-operational headline', () => {
    const html = renderStatusPageHtml(baseSummary({ overall: 'up' }));
    expect(html).toContain('All systems operational');
    expect(html).toContain('✅');
  });

  test('unknown renders the status-unknown headline', () => {
    const html = renderStatusPageHtml(baseSummary({ overall: 'unknown' }));
    expect(html).toContain('Status unknown');
    expect(html).toContain('⚪');
  });
});

describe('renderStatusPageHtml — monitors', () => {
  test('renders empty state when there are no monitors', () => {
    const html = renderStatusPageHtml(baseSummary({ monitors: [] }));
    expect(html).toContain('No monitors on this page yet.');
  });

  test('renders a monitor card with bars, status, and uptime', () => {
    const html = renderStatusPageHtml(
      baseSummary({
        monitors: [
          {
            type: 'url',
            id: 1,
            name: 'API health',
            target: 'https://api.example.com/health',
            currentStatus: 'up',
            uptime24h: 99.87,
            bars90d: Array.from({ length: 90 }, (_, i) => (i % 2 === 0 ? 'up' : 'down')) as (
              | 'up'
              | 'down'
              | 'unknown'
            )[],
          },
        ],
      }),
    );
    expect(html).toContain('monitor-name">API health');
    expect(html).toContain('monitor-target">https://api.example.com/health');
    expect(html).toContain('monitor-status up">up');
    expect(html).toContain('24h uptime: 99.87%');
    expect(html).not.toContain('No monitors on this page yet.');
    // 90 day bars rendered, mix of up/down classes present.
    expect(html).toContain('bar bar-up');
    expect(html).toContain('bar bar-down');
  });

  test('renders "no data" when uptime24h is null', () => {
    const html = renderStatusPageHtml(
      baseSummary({
        monitors: [
          {
            type: 'tcp',
            id: 2,
            name: 'Redis',
            target: 'redis.internal:6379',
            currentStatus: 'unknown',
            uptime24h: null,
            bars90d: Array.from({ length: 90 }, () => 'unknown') as 'unknown'[],
          },
        ],
      }),
    );
    expect(html).toContain('24h uptime: no data');
    expect(html).toContain('monitor-status unknown">unknown');
  });

  test('escapes monitor name/target so injected markup cannot render', () => {
    const html = renderStatusPageHtml(
      baseSummary({
        monitors: [
          {
            type: 'url',
            id: 3,
            name: '<script>alert(1)</script>',
            target: 'https://example.com/"><img src=x>',
            currentStatus: 'down',
            uptime24h: 0,
            bars90d: [],
          },
        ],
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('"><img src=x>');
  });
});

describe('renderStatusPageHtml — page-level rendering', () => {
  test('renders description when present, omits it when absent', () => {
    const withDesc = renderStatusPageHtml(
      baseSummary({ page: { slug: 'x', title: 'X', description: 'All the things' } }),
    );
    expect(withDesc).toContain('<p>All the things</p>');

    const withoutDesc = renderStatusPageHtml(
      baseSummary({ page: { slug: 'x', title: 'X', description: null } }),
    );
    expect(withoutDesc).not.toContain('<p>All the things</p>');
  });

  test('escapes the page title', () => {
    const html = renderStatusPageHtml(
      baseSummary({ page: { slug: 'x', title: '<b>Evil</b> Co', description: null } }),
    );
    expect(html).not.toContain('<b>Evil</b> Co');
    expect(html).toContain('&lt;b&gt;Evil&lt;/b&gt; Co');
  });

  test('applies a theme-light / theme-dark class when themeOverride is set', () => {
    const light = renderStatusPageHtml(baseSummary(), 'light');
    expect(light).toContain('<html lang="en" class="theme-light">');

    const dark = renderStatusPageHtml(baseSummary(), 'dark');
    expect(dark).toContain('<html lang="en" class="theme-dark">');
  });

  test('omits the theme class for an unrecognised themeOverride', () => {
    const html = renderStatusPageHtml(baseSummary(), 'sepia');
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('theme-sepia');
  });

  test('omits the theme class when themeOverride is absent', () => {
    const html = renderStatusPageHtml(baseSummary());
    expect(html).toContain('<html lang="en">');
  });

  test('renders the generatedAt timestamp in the footer', () => {
    const generatedAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const html = renderStatusPageHtml(baseSummary({ generatedAt }));
    expect(html).toContain('Updated Thu, 01 Jan 2026 00:00:00 GMT');
  });
});
