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
