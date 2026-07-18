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

  // Regression: the backtracking input. Against the original pattern this took
  // ~514 ms; the indexOf scan must dispatch it in constant-ish time.
  test('rejects a long backtracking input promptly', () => {
    const attack = `a@${'b.'.repeat(16_000)} `;
    const started = performance.now();
    expect(isValidEmailAddress(attack)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  // The rewrite must not quietly change which addresses are accepted. Compare
  // it against the pattern it replaced across the interesting shapes; within
  // the length cap the two must agree on every input.
  test('agrees with the original shape regex on in-cap inputs', () => {
    const ORIGINAL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    const corpus = [
      'ops@example.com',
      'alerts+prod@mail.example.co.uk',
      'a@b.c',
      'UPPER@Example.COM',
      "o'brien@example.com",
      'dots...everywhere@ex..ample.com',
      '',
      'example.com',
      'ops@localhost',
      'ops@@example.com',
      'ops@ex@ample.com',
      '@example.com',
      'ops@',
      'ops@.com',
      'ops@example.',
      'ops@.',
      'ops @example.com',
      'ops@exa mple.com',
      'ops@example.com ',
      '\tops@example.com',
      'ops@example.com\n',
      'ops @example.com',
    ];
    for (const address of corpus) {
      expect({ address, valid: isValidEmailAddress(address) }).toEqual({
        address,
        valid: ORIGINAL.test(address),
      });
    }
  });
});
