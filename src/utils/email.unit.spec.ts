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

  // The indexOf scan replaced the original shape pattern and must not quietly
  // change which addresses are accepted. Every expectation below was measured
  // against that pattern, so this table is the old contract pinned in place.
  // The pattern itself is deliberately not reproduced here: it would raise a
  // fresh S5852 hotspot, and a spec is no place to reintroduce the very thing
  // this change removes.
  const TAB = String.fromCodePoint(9);
  const NEWLINE = String.fromCodePoint(10);
  test.each([
    ['ops@example.com', true],
    ['a@b.c', true],
    ['UPPER@Example.COM', true],
    ["o'brien@example.com", true],
    ['dots...everywhere@ex..ample.com', true],
    ['', false],
    ['ops@@example.com', false],
    ['ops@ex@ample.com', false],
    ['@example.com', false],
    ['ops@', false],
    ['ops@.com', false],
    ['ops@example.', false],
    ['ops@.', false],
    ['ops@exa mple.com', false],
    ['ops@example.com ', false],
    [`${TAB}ops@example.com`, false],
    [`ops@example.com${NEWLINE}`, false],
  ])('matches the original contract for %j', (address, expected) => {
    expect(isValidEmailAddress(address as string)).toBe(expected);
  });
});
