/**
 * Unit tests for the pure status-code assertion evaluator used by URL
 * monitors. No I/O — covers every operator, the error path when an assertion
 * carries an unknown operator, and the passed/failed message wording.
 */

import { describe, test, expect } from 'bun:test';
import { evaluateUrlMonitorAssertions, type UrlMonitorAssertion } from './url-assertion.ts';

describe('evaluateUrlMonitorAssertions', () => {
  test('equals: passes when status code matches', () => {
    const assertion: UrlMonitorAssertion = { operator: 'equals', statusCode: 200 };
    const [result] = evaluateUrlMonitorAssertions([assertion], 200);
    expect(result.passed).toBe(true);
    expect(result.operator).toBe('equals');
    expect(result.expected).toBe(200);
    expect(result.actual).toBe(200);
    expect(result.message).toBe('Status code 200 equals 200');
  });

  test('equals: fails when status code does not match', () => {
    const assertion: UrlMonitorAssertion = { operator: 'equals', statusCode: 200 };
    const [result] = evaluateUrlMonitorAssertions([assertion], 500);
    expect(result.passed).toBe(false);
    expect(result.message).toBe('Expected status code to equals 200, but got 500');
  });

  test('not_equals: passes when status code differs', () => {
    const assertion: UrlMonitorAssertion = { operator: 'not_equals', statusCode: 500 };
    const [result] = evaluateUrlMonitorAssertions([assertion], 200);
    expect(result.passed).toBe(true);
    expect(result.message).toBe('Status code 200 does not equal 500');
  });

  test('not_equals: fails when status code matches', () => {
    const assertion: UrlMonitorAssertion = { operator: 'not_equals', statusCode: 200 };
    const [result] = evaluateUrlMonitorAssertions([assertion], 200);
    expect(result.passed).toBe(false);
    expect(result.message).toBe('Expected status code to does not equal 200, but got 200');
  });

  test('greater_than: passes / fails correctly', () => {
    const assertion: UrlMonitorAssertion = { operator: 'greater_than', statusCode: 199 };
    const [pass] = evaluateUrlMonitorAssertions([assertion], 200);
    expect(pass.passed).toBe(true);
    expect(pass.message).toBe('Status code 200 is greater than 199');

    const [fail] = evaluateUrlMonitorAssertions([assertion], 100);
    expect(fail.passed).toBe(false);
    expect(fail.message).toBe('Expected status code to is greater than 199, but got 100');
  });

  test('less_than: passes / fails correctly', () => {
    const assertion: UrlMonitorAssertion = { operator: 'less_than', statusCode: 300 };
    const [pass] = evaluateUrlMonitorAssertions([assertion], 200);
    expect(pass.passed).toBe(true);
    expect(pass.message).toBe('Status code 200 is less than 300');

    const [fail] = evaluateUrlMonitorAssertions([assertion], 400);
    expect(fail.passed).toBe(false);
  });

  test('unknown operator: caught and surfaced as a failed result, not thrown', () => {
    const assertion = { operator: 'bogus', statusCode: 200 } as unknown as UrlMonitorAssertion;
    const [result] = evaluateUrlMonitorAssertions([assertion], 200);
    expect(result.passed).toBe(false);
    expect(result.operator).toBe('bogus');
    expect(result.message).toBe('Error evaluating assertion: Unknown operator: bogus');
    expect(result.expected).toBe(200);
    expect(result.actual).toBe(200);
  });

  test('evaluates multiple assertions independently and preserves order', () => {
    const assertions: UrlMonitorAssertion[] = [
      { operator: 'equals', statusCode: 200 },
      { operator: 'greater_than', statusCode: 500 },
    ];
    const results = evaluateUrlMonitorAssertions(assertions, 200);
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
  });

  test('empty assertions array returns empty results', () => {
    expect(evaluateUrlMonitorAssertions([], 200)).toEqual([]);
  });
});
