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
});
