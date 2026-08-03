import { describe, expect, test } from 'bun:test';
import {
  badPort,
  parseExpectCnRegex,
  validateApiAssertions,
  validatePayloadHex,
} from './monitor-route-validation.ts';

describe('monitor-route-validation', () => {
  test('badPort rejects out-of-range ports', () => {
    expect(badPort(0)).toBe(true);
    expect(badPort(65536)).toBe(true);
    expect(badPort(1.5)).toBe(true);
    expect(badPort(443)).toBe(false);
  });

  test('validatePayloadHex accepts empty and valid hex', () => {
    expect(validatePayloadHex(null)).toBeNull();
    expect(validatePayloadHex('')).toBeNull();
    expect(validatePayloadHex('deadbeef')).toBeNull();
    expect(validatePayloadHex('not-hex')).toContain('hex');
  });

  test('validateApiAssertions rejects bad shapes', () => {
    expect(validateApiAssertions('nope')).toBe('assertions must be an array');
    expect(
      validateApiAssertions([{ type: 'status_code', operator: 'equals' }], { shortErrors: true }),
    ).toBeNull();
    expect(
      validateApiAssertions([{ type: 'bogus', operator: 'equals' }], { shortErrors: true }),
    ).toBe('assertions[0].type invalid');
  });

  test('parseExpectCnRegex stringifies primitives only', () => {
    expect(parseExpectCnRegex(null)).toEqual({ value: null });
    expect(parseExpectCnRegex('^foo$')).toEqual({ value: '^foo$' });
    expect(parseExpectCnRegex(42)).toEqual({ value: '42' });
    expect(parseExpectCnRegex({})).toEqual({ value: null });
    expect(parseExpectCnRegex('[')).toMatchObject({ error: expect.stringContaining('invalid') });
  });
});
