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
});

type MonitorRow = StatusPageSummary['monitors'][number];

function monitor(overrides: Partial<MonitorRow> = {}): MonitorRow {
  return {
    type: 'url',
    id: 1,
    name: 'API',
    target: 'https://api.example.com',
    currentStatus: 'up',
    uptime24h: 100,
    bars90d: ['up'],
    ...overrides,
  } as MonitorRow;
}

describe('renderStatusPageHtml — monitor rows', () => {
  test('renders a row per monitor with its name, target and status class', () => {
    const html = renderStatusPageHtml(
      baseSummary({
        monitors: [
          monitor({ id: 1, name: 'API', target: 'https://api.example.com' }),
          monitor({ id: 2, name: 'Web', target: 'https://example.com', currentStatus: 'down' }),
        ],
      }),
    );

    expect(html).not.toContain('No monitors on this page yet.');
    expect(html).toContain('<div class="monitor-name">API</div>');
    expect(html).toContain('<div class="monitor-target">https://api.example.com</div>');
    expect(html).toContain('<div class="monitor-name">Web</div>');
    // Status drives both the class and the visible text.
    expect(html).toContain('<div class="monitor-status down">down</div>');
  });

  test('falls back to the empty-state copy when the page has no monitors', () => {
    expect(renderStatusPageHtml(baseSummary({ monitors: [] }))).toContain(
      'No monitors on this page yet.',
    );
  });

  test('escapes monitor name and target rather than emitting raw markup', () => {
    const html = renderStatusPageHtml(
      baseSummary({
        monitors: [monitor({ name: '<script>x</script>', target: 'a&b"c' })],
      }),
    );

    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('a&amp;b&quot;c');
  });

  test('emits one bar per 90d entry, oldest first, each titled with its own day', () => {
    // The renderer dates bars as `89 - idx` days back, so a full 90-slot
    // series is the only one whose last entry lands on today.
    const bars90d = Array.from({ length: 90 }, (_, i) =>
      i === 89 ? 'down' : i === 0 ? 'unknown' : 'up',
    ) as MonitorRow['bars90d'];

    const html = renderStatusPageHtml(baseSummary({ monitors: [monitor({ bars90d })] }));

    expect(html.match(/<span class="bar bar-\w+"/g) ?? []).toHaveLength(90);

    const day = (back: number) =>
      new Date(Date.now() - back * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    // Newest slot is today, oldest is 89 days back.
    expect(html).toContain(`class="bar bar-down" title="${day(0)}: down"`);
    expect(html).toContain(`class="bar bar-unknown" title="${day(89)}: unknown"`);
  });

  test('shows a percentage for a known 24h uptime and "no data" for null', () => {
    const known = renderStatusPageHtml(baseSummary({ monitors: [monitor({ uptime24h: 99.5 })] }));
    expect(known).toContain('24h uptime: 99.5%');

    const unknown = renderStatusPageHtml(baseSummary({ monitors: [monitor({ uptime24h: null })] }));
    expect(unknown).toContain('24h uptime: no data');
    expect(unknown).not.toContain('24h uptime: null');
  });
});

describe('renderStatusPageHtml — overall headline', () => {
  const cases: [StatusPageSummary['overall'], string, string][] = [
    ['up', 'All systems operational', '✅'],
    ['degraded', 'Some services are degraded', '⚠️'],
    ['down', 'Some services are degraded', '🔥'],
    ['unknown', 'Status unknown', '⚪'],
  ];

  for (const [overall, label, emoji] of cases) {
    test(`${overall} renders "${label}"`, () => {
      const html = renderStatusPageHtml(baseSummary({ overall }));
      expect(html).toContain(label);
      expect(html).toContain(emoji);
    });
  }
});
