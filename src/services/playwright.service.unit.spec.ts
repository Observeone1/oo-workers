/**
 * Unit tests for the pure helpers in playwright.service.ts. The IO-heavy
 * `executePlaywrightTest` is covered end-to-end in
 * tests/integration/playwright-runner.it.spec.ts — it actually spawns
 * `npx playwright test`, which doesn't belong in a unit suite.
 */

import { describe, test, expect } from 'bun:test';
import { buildCredentialEnv, extractStderrSummary } from './playwright.service.ts';

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

describe('buildCredentialEnv', () => {
  test('passes conventional login credential keys through as env vars', () => {
    expect(buildCredentialEnv({ LOGIN_EMAIL: 'a@b.com', LOGIN_PASSWORD: 'secret' })).toEqual({
      LOGIN_EMAIL: 'a@b.com',
      LOGIN_PASSWORD: 'secret',
    });
  });

  test('returns an empty object when no credentials are supplied', () => {
    expect(buildCredentialEnv(undefined)).toEqual({});
  });

  test('drops process-hijacking keys (PATH / NODE_OPTIONS / LD_*) even if supplied', () => {
    const env = buildCredentialEnv({
      PATH: '/evil/bin',
      NODE_OPTIONS: '--require /evil.js',
      LD_PRELOAD: '/evil.so',
      LOGIN_EMAIL: 'a@b.com',
    });
    expect(env).toEqual({ LOGIN_EMAIL: 'a@b.com' });
  });

  test('drops the PLAYWRIGHT_* contract vars this service sets itself', () => {
    expect(buildCredentialEnv({ PLAYWRIGHT_TARGET_URL: 'http://evil' })).toEqual({});
  });

  test('drops the whole NODE_/BUN_/LD_/DYLD_ runtime+loader prefix families', () => {
    expect(
      buildCredentialEnv({
        NODE_PATH: '/evil',
        NODE_EXTRA_CA_CERTS: '/evil.pem',
        BUN_INSTALL: '/evil',
        DYLD_FRAMEWORK_PATH: '/evil',
        LOGIN_EMAIL: 'a@b.com',
      }),
    ).toEqual({ LOGIN_EMAIL: 'a@b.com' });
  });

  test('ignores keys that are not valid env-var identifiers', () => {
    expect(buildCredentialEnv({ 'not a var': 'x', '1STARTS_NUM': 'y', OK_KEY: 'z' })).toEqual({
      OK_KEY: 'z',
    });
  });

  test('ignores non-string values', () => {
    expect(buildCredentialEnv({ GOOD: 'v', BAD: 123 as unknown as string })).toEqual({ GOOD: 'v' });
  });
});
