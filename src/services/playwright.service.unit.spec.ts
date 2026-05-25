/**
 * Unit tests for the pure helpers in playwright.service.ts. The IO-heavy
 * `executePlaywrightTest` is covered end-to-end in
 * tests/integration/playwright-runner.it.spec.ts — it actually spawns
 * `npx playwright test`, which doesn't belong in a unit suite.
 */

import { describe, test, expect } from 'bun:test';
import { extractStderrSummary } from './playwright.service.ts';

describe('extractStderrSummary', () => {
  test('strips ANSI colour codes', () => {
    const colored = '[31mError: oh no[0m';
    expect(extractStderrSummary(colored)).toBe('Error: oh no');
  });

  test('drops empty lines and trailing whitespace', () => {
    const stderr = 'line1   \n\n\nline2\n   \nline3';
    expect(extractStderrSummary(stderr)).toBe('line1\nline2\nline3');
  });

  test('caps output at the first N lines', () => {
    const stderr = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const out = extractStderrSummary(stderr, 5);
    expect(out.split('\n')).toHaveLength(5);
    expect(out.split('\n').at(-1)).toBe('line4');
  });

  test('preserves the actual error content used in the bug fix (bad import)', () => {
    const bad =
      "Error: Cannot find module 'totally-not-installed'\n" +
      'Require stack:\n' +
      '- /tmp/test.spec.ts\n';
    const out = extractStderrSummary(bad);
    expect(out).toContain('Cannot find module');
    expect(out).toContain('totally-not-installed');
  });

  test('empty string in → empty string out (no spurious newline)', () => {
    expect(extractStderrSummary('')).toBe('');
  });
});
