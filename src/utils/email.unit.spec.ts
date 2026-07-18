import { describe, test, expect } from 'bun:test';
import { isValidEmailAddress, MAX_EMAIL_LENGTH } from './email.ts';

describe('isValidEmailAddress', () => {
  test('accepts an ordinary address', () => {
    expect(isValidEmailAddress('ops@example.com')).toBe(true);
  });

  test('accepts a subdomain and plus-tagged address', () => {
    expect(isValidEmailAddress('alerts+prod@mail.example.co.uk')).toBe(true);
  });

  test('rejects an address with no @', () => {
    expect(isValidEmailAddress('example.com')).toBe(false);
  });

  test('rejects an address with no dot in the domain', () => {
    expect(isValidEmailAddress('ops@localhost')).toBe(false);
  });

  test('rejects whitespace', () => {
    expect(isValidEmailAddress('ops @example.com')).toBe(false);
  });

  test('accepts an address exactly at the length limit', () => {
    const local = 'a'.repeat(MAX_EMAIL_LENGTH - '@example.com'.length);
    const address = `${local}@example.com`;
    expect(address).toHaveLength(MAX_EMAIL_LENGTH);
    expect(isValidEmailAddress(address)).toBe(true);
  });

  // Regression: before the length cap this shape passed the regex and was
  // stored as a channel recipient. It is also the ReDoS lever — see email.ts.
  test('rejects a well-formed address one octet over the limit', () => {
    const local = 'a'.repeat(MAX_EMAIL_LENGTH + 1 - '@example.com'.length);
    const address = `${local}@example.com`;
    expect(address).toHaveLength(MAX_EMAIL_LENGTH + 1);
    expect(isValidEmailAddress(address)).toBe(false);
  });

  // Regression: the backtracking input. On the uncapped regex this call took
  // ~514 ms; the length check must reject it without running the pattern.
  test('rejects a long backtracking input promptly', () => {
    const attack = `a@${'b.'.repeat(16_000)} `;
    const started = performance.now();
    expect(isValidEmailAddress(attack)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
