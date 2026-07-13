/**
 * URL-monitor assertion contract. The operator semantics here gate every
 * url-monitor pass/fail verdict, and the loose `==` comparison is load-
 * bearing: assertion values are stored as TEXT, so a numeric status 200
 * must match the string "200" (see compareValues in url-assertion.ts).
 */

import { describe, test, expect } from 'bun:test';
import { evaluateUrlMonitorAssertions, type UrlMonitorAssertion } from './url-assertion.ts';

const assertion = (
  operator: UrlMonitorAssertion['operator'],
  statusCode: number,
): UrlMonitorAssertion => ({ operator, statusCode });

describe('evaluateUrlMonitorAssertions', () => {
  test('equals passes on match and fails on mismatch', () => {
    const [pass, fail] = evaluateUrlMonitorAssertions(
      [assertion('equals', 200), assertion('equals', 301)],
      200,
    );
    expect(pass.passed).toBe(true);
    expect(pass.expected).toBe(200);
    expect(pass.actual).toBe(200);
    expect(fail.passed).toBe(false);
    expect(fail.message).toBe('Expected status code to equals 301, but got 200');
  });

  test('equals matches across string/number representations (TEXT-stored values)', () => {
    // DB stores assertion values as TEXT; a "200" string must equal status 200.
    const stringly = { operator: 'equals', statusCode: '200' } as unknown as UrlMonitorAssertion;
    const [result] = evaluateUrlMonitorAssertions([stringly], 200);
    expect(result.passed).toBe(true);
  });

  test('not_equals is the exact inverse of equals', () => {
    const [differs, same] = evaluateUrlMonitorAssertions(
      [assertion('not_equals', 500), assertion('not_equals', 404)],
      404,
    );
    expect(differs.passed).toBe(true);
    expect(same.passed).toBe(false);
  });

  test('greater_than / less_than are strict (boundary value fails both)', () => {
    const results = evaluateUrlMonitorAssertions(
      [
        assertion('greater_than', 299), // 300 > 299 → pass
        assertion('greater_than', 300), // 300 > 300 → fail
        assertion('less_than', 301), // 300 < 301 → pass
        assertion('less_than', 300), // 300 < 300 → fail
      ],
      300,
    );
    expect(results.map((r) => r.passed)).toEqual([true, false, true, false]);
  });

  test('every result echoes operator, expected, and actual for the UI', () => {
    const [result] = evaluateUrlMonitorAssertions([assertion('less_than', 400)], 200);
    expect(result).toEqual({
      operator: 'less_than',
      passed: true,
      message: 'Status code 200 is less than 400',
      expected: 400,
      actual: 200,
    });
  });

  test('an unknown operator fails the assertion instead of throwing', () => {
    const bad = { operator: 'matches', statusCode: 200 } as unknown as UrlMonitorAssertion;
    const [result] = evaluateUrlMonitorAssertions([bad, assertion('equals', 200)], 200);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('Unknown operator: matches');
    // ...and does not poison evaluation of the remaining assertions.
    const second = evaluateUrlMonitorAssertions([bad, assertion('equals', 200)], 200)[1];
    expect(second.passed).toBe(true);
  });

  test('empty assertion list yields no results', () => {
    expect(evaluateUrlMonitorAssertions([], 200)).toEqual([]);
  });
});
