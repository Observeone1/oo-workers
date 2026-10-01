/**
 * jsonpath's static-eval-backed script/filter expressions ($[(...)],
 * $[?(...)]) are CVE-2026-1615 (arbitrary code execution). `path` is
 * user-editable on an api_check assertion, so any parenthesized expression
 * must be rejected before reaching jsonpath.query, never evaluated.
 */

import { describe, test, expect } from 'bun:test';
import { evaluateAssertions, type ApiAssertion } from './api-assertion.ts';

describe('evaluateAssertions - json_path safety', () => {
  test('rejects a script-expression path instead of evaluating it', async () => {
    // Harmless arithmetic probe: if static-eval is reachable, `(1+1)` resolves
    // to index 2 and matches 30. A safe implementation must never get that far.
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'json_path',
      operator: 'equals',
      path: '$[(1+1)]',
      value: '30',
    };

    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 10,
      body: '[10,20,30,40,50]',
      headers: {},
    });

    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/unsafe|not allowed|disallowed/i);
  });

  test('rejects a filter-expression path instead of evaluating it', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'json_path',
      operator: 'exists',
      path: '$[?(1==1)]',
    };

    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 10,
      body: '[10,20,30]',
      headers: {},
    });

    expect(result.passed).toBe(false);
    expect(result.message).toMatch(/unsafe|not allowed|disallowed/i);
  });

  test('still evaluates ordinary dot/bracket JSONPath syntax', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'json_path',
      operator: 'equals',
      path: '$.data[0].status',
      value: 'ok',
    };

    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 10,
      body: '{"data":[{"status":"ok"}]}',
      headers: {},
    });

    expect(result.passed).toBe(true);
  });

  // The guard is a paren rejection, not a syntax allowlist. These are the
  // non-parenthesized forms jsonpath supports; if any of them were rejected the
  // mitigation would have silently broken legitimate assertions.
  const body = '{"data":[{"status":"ok"},{"status":"bad"}],"n":3,"tags":{"b":2,"a":1}}';
  // Each of these resolves against the body above, so asserting `exists`
  // passes only if the path both ran and matched — not merely if it avoided
  // the rejection message.
  const allowed: Array<[label: string, path: string]> = [
    ['wildcard', '$.data[*].status'],
    ['slice', '$.data[0:2].status'],
    ['union', '$..status'],
    ['nested bracket', '$.tags["a"]'],
    ['root default', '$'],
  ];

  for (const [label, path] of allowed) {
    test(`allows non-parenthesized syntax: ${label}`, async () => {
      const [result] = await evaluateAssertions(
        [{ api_check_id: 1, type: 'json_path', operator: 'exists', path }],
        { status: 200, responseTime: 10, body, headers: {} },
      );
      expect(result.message).not.toMatch(/not allowed/i);
      expect(result.passed).toBe(true);
    });
  }

  // Any paren is rejected regardless of position, and the rejection must not
  // depend on jsonpath being reached first.
  const rejected: Array<[label: string, path: string]> = [
    ['leading', '(1+1)'],
    ['nested deep', '$.a[0].b[(1+1)]'],
    ['closing only', '$.a)'],
    ['whitespace-padded', '  $.a[ (1) ]  '],
  ];

  for (const [label, path] of rejected) {
    test(`rejects a paren anywhere in the path: ${label}`, async () => {
      const [result] = await evaluateAssertions(
        [{ api_check_id: 1, type: 'json_path', operator: 'exists', path }],
        { status: 200, responseTime: 10, body, headers: {} },
      );
      expect(result.passed).toBe(false);
      expect(result.message).toMatch(/not allowed/i);
    });
  }
});
