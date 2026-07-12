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

describe('evaluateAssertions - status_code', () => {
  test('passes when status matches with default equals value', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'status_code',
      operator: 'equals',
      value: '200',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 10,
      body: '{}',
      headers: {},
    });
    expect(result.passed).toBe(true);
    expect(result.type).toBe('status_code');
    expect(result.expected).toBe(200);
    expect(result.actual).toBe(200);
    expect(result.message).toBe('Status code 200 equals 200');
  });

  test('defaults expected value to 200 when no value is supplied', async () => {
    const assertion: ApiAssertion = { api_check_id: 1, type: 'status_code', operator: 'equals' };
    const [result] = await evaluateAssertions([assertion], {
      status: 404,
      responseTime: 10,
      body: '',
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.expected).toBe(200);
    expect(result.message).toBe('Expected status code to equals 200, but got 404');
  });

  test('greater_than / less_than operators', async () => {
    const gt: ApiAssertion = {
      api_check_id: 1,
      type: 'status_code',
      operator: 'greater_than',
      value: '199',
    };
    const [gtResult] = await evaluateAssertions([gt], {
      status: 201,
      responseTime: 1,
      body: '',
      headers: {},
    });
    expect(gtResult.passed).toBe(true);

    const lt: ApiAssertion = {
      api_check_id: 1,
      type: 'status_code',
      operator: 'less_than',
      value: '300',
    };
    const [ltResult] = await evaluateAssertions([lt], {
      status: 500,
      responseTime: 1,
      body: '',
      headers: {},
    });
    expect(ltResult.passed).toBe(false);
    expect(ltResult.message).toBe('Expected status code to is less than 300, but got 500');
  });
});

describe('evaluateAssertions - response_time', () => {
  test('passes when response time is within the expected bound', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'response_time',
      operator: 'less_than',
      value: '1000',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 250,
      body: '',
      headers: {},
    });
    expect(result.passed).toBe(true);
    expect(result.type).toBe('response_time');
    expect(result.message).toBe('Response time 250ms is less than 1000ms');
  });

  test('defaults expected value to 1000ms when no value is supplied', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'response_time',
      operator: 'less_than',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 2500,
      body: '',
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.expected).toBe(1000);
    expect(result.message).toBe('Expected response time to is less than 1000ms, but got 2500ms');
  });
});

describe('evaluateAssertions - text_contains', () => {
  const body = 'Hello World';

  test('contains: case-insensitive substring match', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'text_contains',
      operator: 'contains',
      value: 'world',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body,
      headers: {},
    });
    expect(result.passed).toBe(true);
    expect(result.actual).toBe(body);
  });

  test('not_contains: fails when substring is present', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'text_contains',
      operator: 'not_contains',
      value: 'World',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body,
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.message).toBe("Expected response body to does not contain 'World'");
  });

  test('equals / not_equals compare the whole body', async () => {
    const eq: ApiAssertion = {
      api_check_id: 1,
      type: 'text_contains',
      operator: 'equals',
      value: body,
    };
    const [eqResult] = await evaluateAssertions([eq], {
      status: 200,
      responseTime: 1,
      body,
      headers: {},
    });
    expect(eqResult.passed).toBe(true);

    const neq: ApiAssertion = {
      api_check_id: 1,
      type: 'text_contains',
      operator: 'not_equals',
      value: body,
    };
    const [neqResult] = await evaluateAssertions([neq], {
      status: 200,
      responseTime: 1,
      body,
      headers: {},
    });
    expect(neqResult.passed).toBe(false);
  });

  test('truncates actual body to 200 chars in the result', async () => {
    const longBody = 'x'.repeat(500);
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'text_contains',
      operator: 'contains',
      value: 'x',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: longBody,
      headers: {},
    });
    expect(result.actual).toHaveLength(200);
  });

  test('unsupported operator throws and is caught by evaluateAssertions', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'text_contains',
      operator: 'exists',
      value: 'x',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body,
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain('Assertion evaluation failed');
    expect(result.message).toContain("Operator 'exists' not supported");
  });
});

describe('evaluateAssertions - header', () => {
  test('exists: passes when the header is present', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'header',
      operator: 'exists',
      path: 'Content-Type',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: '',
      headers: { 'content-type': 'application/json' },
    });
    expect(result.passed).toBe(true);
    expect(result.message).toBe("Header 'Content-Type' exists");
    expect(result.actual).toBe('application/json');
  });

  test('exists: fails when the header is absent', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'header',
      operator: 'exists',
      path: 'X-Missing',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: '',
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.message).toBe("Header 'X-Missing' does not exist");
    expect(result.actual).toBeNull();
  });

  test('equals: matches header value, falls back to lowercase header name', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'header',
      operator: 'equals',
      path: 'X-Custom',
      value: 'abc',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: '',
      headers: { 'x-custom': 'abc' },
    });
    expect(result.passed).toBe(true);
  });

  test('equals: fails with descriptive message when header value differs', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'header',
      operator: 'equals',
      path: 'X-Custom',
      value: 'abc',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: '',
      headers: { 'X-Custom': 'xyz' },
    });
    expect(result.passed).toBe(false);
    expect(result.message).toBe("Expected header 'X-Custom' to equals 'abc', but got 'xyz'");
  });

  test('equals: reports undefined when header is missing entirely', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'header',
      operator: 'equals',
      path: 'X-Missing',
      value: 'abc',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: '',
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.message).toBe("Expected header 'X-Missing' to equals 'abc', but got 'undefined'");
    expect(result.actual).toBeNull();
  });
});

describe('evaluateAssertions - error handling', () => {
  test('unknown assertion type is caught and surfaced as a failed result', async () => {
    const assertion = {
      api_check_id: 1,
      type: 'bogus_type',
      operator: 'equals',
      value: 'x',
    } as unknown as ApiAssertion;
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: '',
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.type).toBe('bogus_type');
    expect(result.message).toContain('Assertion evaluation failed');
    expect(result.message).toContain('Unknown assertion type: bogus_type');
    expect(result.expected).toBe('x');
    expect(result.actual).toBeNull();
  });

  test('json_path: malformed response body is reported, not thrown', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'json_path',
      operator: 'equals',
      path: '$.a',
      value: '1',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: 'not json',
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.message).toContain('Failed to parse JSON response');
  });

  test('json_path: path not found in response', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'json_path',
      operator: 'equals',
      path: '$.missing',
      value: '1',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: '{"a":1}',
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.message).toBe("JSONPath '$.missing' not found in response");
  });

  test('json_path: exists operator reports absence correctly', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'json_path',
      operator: 'exists',
      path: '$.missing',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: '{"a":1}',
      headers: {},
    });
    expect(result.passed).toBe(false);
    expect(result.message).toBe("JSONPath '$.missing' does not exist in response");
  });

  test('json_path: matched value that fails to parse as JSON is compared as a string', async () => {
    const assertion: ApiAssertion = {
      api_check_id: 1,
      type: 'json_path',
      operator: 'equals',
      path: '$.name',
      value: 'alice',
    };
    const [result] = await evaluateAssertions([assertion], {
      status: 200,
      responseTime: 1,
      body: '{"name":"alice"}',
      headers: {},
    });
    expect(result.passed).toBe(true);
  });

  test('evaluates several assertions in one call, isolating failures per-assertion', async () => {
    const assertions: ApiAssertion[] = [
      { api_check_id: 1, type: 'status_code', operator: 'equals', value: '200' },
      { api_check_id: 2, type: 'bogus' as ApiAssertion['type'], operator: 'equals' },
    ];
    const results = await evaluateAssertions(assertions, {
      status: 200,
      responseTime: 1,
      body: '',
      headers: {},
    });
    expect(results).toHaveLength(2);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
  });
});
