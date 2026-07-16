/**
 * Behavioural coverage for evaluateAssertions across every assertion type and
 * operator, plus the error branches (unsupported operator, unknown type,
 * unparseable body). The json_path CVE-safety cases live in
 * api-assertion.unit.spec.ts; this file covers the rest of the evaluators.
 */
import { describe, test, expect } from 'bun:test';
import { evaluateAssertions, type ApiAssertion } from './api-assertion.ts';

type Resp = { status: number; responseTime: number; body: string; headers: Record<string, string> };
const resp = (over: Partial<Resp> = {}): Resp => ({
  status: 200,
  responseTime: 10,
  body: '',
  headers: {},
  ...over,
});

const evalOne = async (assertion: ApiAssertion, over: Partial<Resp> = {}) =>
  (await evaluateAssertions([assertion], resp(over)))[0];

const a = (over: Partial<ApiAssertion>): ApiAssertion => ({
  api_check_id: 1,
  type: 'status_code',
  operator: 'equals',
  ...over,
});

describe('evaluateAssertions - status_code', () => {
  test('passes when the status equals the expected value', async () => {
    const r = await evalOne(a({ type: 'status_code', operator: 'equals', value: '200' }), {
      status: 200,
    });
    expect(r).toMatchObject({ type: 'status_code', passed: true, expected: 200, actual: 200 });
    expect(r.message).toContain('equals');
  });

  test('fails and explains the mismatch', async () => {
    const r = await evalOne(a({ type: 'status_code', operator: 'equals', value: '404' }), {
      status: 200,
    });
    expect(r.passed).toBe(false);
    expect(r.message).toBe('Expected status code to equals 404, but got 200');
  });

  test('defaults the expected status to 200 when no value is given', async () => {
    const r = await evalOne(a({ type: 'status_code', operator: 'equals' }), { status: 200 });
    expect(r).toMatchObject({ passed: true, expected: 200 });
  });

  test('supports greater_than / less_than numeric comparisons', async () => {
    expect(
      (
        await evalOne(a({ type: 'status_code', operator: 'greater_than', value: '199' }), {
          status: 200,
        })
      ).passed,
    ).toBe(true);
    expect(
      (
        await evalOne(a({ type: 'status_code', operator: 'less_than', value: '200' }), {
          status: 200,
        })
      ).passed,
    ).toBe(false);
  });
});

describe('evaluateAssertions - response_time', () => {
  test('passes when under the threshold and defaults to 1000ms', async () => {
    const r = await evalOne(a({ type: 'response_time', operator: 'less_than' }), {
      responseTime: 10,
    });
    expect(r).toMatchObject({ type: 'response_time', passed: true, expected: 1000, actual: 10 });
  });

  test('fails when slower than the expected ceiling', async () => {
    const r = await evalOne(a({ type: 'response_time', operator: 'less_than', value: '5' }), {
      responseTime: 50,
    });
    expect(r.passed).toBe(false);
    expect(r.message).toContain('50ms');
  });
});

describe('evaluateAssertions - json_path (values)', () => {
  test('exists passes when the path resolves', async () => {
    const r = await evalOne(a({ type: 'json_path', operator: 'exists', path: '$.a' }), {
      body: '{"a":1}',
    });
    expect(r).toMatchObject({ passed: true });
    expect(r.message).toContain('exists in response');
  });

  test('exists fails when the path is absent', async () => {
    const r = await evalOne(a({ type: 'json_path', operator: 'exists', path: '$.missing' }), {
      body: '{}',
    });
    expect(r.passed).toBe(false);
    expect(r.message).toContain('does not exist');
  });

  test('compares a numeric value parsed out of the expected string', async () => {
    const r = await evalOne(
      a({ type: 'json_path', operator: 'equals', path: '$.code', value: '200' }),
      { body: '{"code":200}' },
    );
    expect(r).toMatchObject({ passed: true, expected: 200, actual: 200 });
  });

  test('keeps the expected value as a string when it is not JSON', async () => {
    const r = await evalOne(
      a({ type: 'json_path', operator: 'contains', path: '$.name', value: 'ell' }),
      { body: '{"name":"hello"}' },
    );
    expect(r.passed).toBe(true);
  });

  test('reports a path that matches nothing', async () => {
    const r = await evalOne(a({ type: 'json_path', operator: 'equals', path: '$.x', value: '1' }), {
      body: '{"a":1}',
    });
    expect(r.passed).toBe(false);
    expect(r.message).toContain('not found');
  });

  test('reports an unparseable JSON body', async () => {
    const r = await evalOne(a({ type: 'json_path', operator: 'equals', path: '$.a', value: '1' }), {
      body: 'definitely not json',
    });
    expect(r.passed).toBe(false);
    expect(r.message).toContain('Failed to parse JSON response');
  });
});

describe('evaluateAssertions - text_contains', () => {
  test('contains is case-insensitive', async () => {
    const r = await evalOne(a({ type: 'text_contains', operator: 'contains', value: 'WORLD' }), {
      body: 'hello world',
    });
    expect(r.passed).toBe(true);
  });

  test('not_contains, equals and not_equals', async () => {
    expect(
      (
        await evalOne(a({ type: 'text_contains', operator: 'not_contains', value: 'zzz' }), {
          body: 'abc',
        })
      ).passed,
    ).toBe(true);
    expect(
      (
        await evalOne(a({ type: 'text_contains', operator: 'equals', value: 'exact' }), {
          body: 'exact',
        })
      ).passed,
    ).toBe(true);
    expect(
      (
        await evalOne(a({ type: 'text_contains', operator: 'not_equals', value: 'x' }), {
          body: 'y',
        })
      ).passed,
    ).toBe(true);
  });

  test('an unsupported operator surfaces as a failed evaluation', async () => {
    const r = await evalOne(a({ type: 'text_contains', operator: 'greater_than', value: 'x' }), {
      body: 'y',
    });
    expect(r.passed).toBe(false);
    expect(r.message).toContain('Assertion evaluation failed');
  });
});

describe('evaluateAssertions - header', () => {
  test('exists passes when the header is present', async () => {
    const r = await evalOne(a({ type: 'header', operator: 'exists', path: 'X-Test' }), {
      headers: { 'X-Test': '1' },
    });
    expect(r).toMatchObject({ passed: true });
    expect(r.message).toContain('exists');
  });

  test('exists fails when the header is missing', async () => {
    const r = await evalOne(a({ type: 'header', operator: 'exists', path: 'X-None' }), {
      headers: {},
    });
    expect(r.passed).toBe(false);
  });

  test('matches a header case-insensitively via the lowercase fallback', async () => {
    const r = await evalOne(
      a({ type: 'header', operator: 'equals', path: 'Content-Type', value: 'application/json' }),
      { headers: { 'content-type': 'application/json' } },
    );
    expect(r.passed).toBe(true);
  });

  test('fails with a null actual when the header is absent', async () => {
    const r = await evalOne(a({ type: 'header', operator: 'equals', path: 'X-No', value: 'v' }), {
      headers: {},
    });
    expect(r).toMatchObject({ passed: false, actual: null });
  });
});

describe('evaluateAssertions - dispatch', () => {
  test('evaluates every assertion in order', async () => {
    const results = await evaluateAssertions(
      [
        a({ type: 'status_code', operator: 'equals', value: '200' }),
        a({ type: 'response_time', operator: 'less_than', value: '1000' }),
      ],
      resp({ status: 200, responseTime: 5 }),
    );
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.type)).toEqual(['status_code', 'response_time']);
  });

  test('an unknown assertion type is caught and reported', async () => {
    const bogus = {
      api_check_id: 1,
      type: 'teapot',
      operator: 'equals',
    } as unknown as ApiAssertion;
    const r = (await evaluateAssertions([bogus], resp()))[0];
    expect(r.passed).toBe(false);
    expect(r.message).toContain('Assertion evaluation failed');
  });
});
