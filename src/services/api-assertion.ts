import jsonpath from 'jsonpath';
import { logger } from '../utils/logger.ts';

export interface ApiAssertion {
  id?: number;
  api_check_id: number;
  type: 'status_code' | 'response_time' | 'json_path' | 'text_contains' | 'header';
  operator: 'equals' | 'not_equals' | 'less_than' | 'greater_than' | 'contains' | 'not_contains' | 'exists';
  path?: string;
  value?: string;
  created_at?: Date;
}

export interface AssertionResult {
  type?: string;
  passed: boolean;
  message: string;
  expected?: any;
  actual?: any;
}

interface ResponseData {
  status: number;
  responseTime: number;
  body: string;
  headers: Record<string, string>;
}

/**
 * Evaluate all assertions against an API check response.
 */
export const evaluateAssertions = async (
  assertions: ApiAssertion[],
  responseData: ResponseData,
): Promise<AssertionResult[]> => {
  const results: AssertionResult[] = [];

  for (const assertion of assertions) {
    try {
      const result = await evaluateAssertion(assertion, responseData);
      results.push(result);
    } catch (error) {
      logger.error(`Failed to evaluate assertion ${assertion.id}: ${error instanceof Error ? error.message : String(error)}`);
      results.push({
        type: assertion.type,
        passed: false,
        message: `Assertion evaluation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        expected: assertion.value,
        actual: null,
      });
    }
  }

  return results;
};

const evaluateAssertion = async (assertion: ApiAssertion, responseData: ResponseData): Promise<AssertionResult> => {
  switch (assertion.type) {
    case 'status_code':   return evaluateStatusCode(assertion, responseData.status);
    case 'response_time': return evaluateResponseTime(assertion, responseData.responseTime);
    case 'json_path':     return evaluateJsonPath(assertion, responseData.body);
    case 'text_contains': return evaluateTextContains(assertion, responseData.body);
    case 'header':        return evaluateHeader(assertion, responseData.headers);
    default:              throw new Error(`Unknown assertion type: ${assertion.type}`);
  }
};

const evaluateStatusCode = (assertion: ApiAssertion, actualStatus: number): AssertionResult => {
  const expectedValue = assertion.value ? parseInt(assertion.value) : 200;
  const passed = compareValues(actualStatus, expectedValue, assertion.operator);
  return {
    type: 'status_code',
    passed,
    message: passed
      ? `Status code ${actualStatus} ${getOperatorText(assertion.operator)} ${expectedValue}`
      : `Expected status code to ${getOperatorText(assertion.operator)} ${expectedValue}, but got ${actualStatus}`,
    expected: expectedValue,
    actual: actualStatus,
  };
};

const evaluateResponseTime = (assertion: ApiAssertion, actualTime: number): AssertionResult => {
  const expectedValue = assertion.value ? parseInt(assertion.value) : 1000;
  const passed = compareValues(actualTime, expectedValue, assertion.operator);
  return {
    type: 'response_time',
    passed,
    message: passed
      ? `Response time ${actualTime}ms ${getOperatorText(assertion.operator)} ${expectedValue}ms`
      : `Expected response time to ${getOperatorText(assertion.operator)} ${expectedValue}ms, but got ${actualTime}ms`,
    expected: expectedValue,
    actual: actualTime,
  };
};

const evaluateJsonPath = (assertion: ApiAssertion, responseBody: string): AssertionResult => {
  try {
    const json = JSON.parse(responseBody);
    const path = assertion.path || '$';
    const matches = jsonpath.query(json, path);

    if (assertion.operator === 'exists') {
      const passed = matches.length > 0;
      return {
        type: 'json_path',
        passed,
        message: passed
          ? `JSONPath '${path}' exists in response`
          : `JSONPath '${path}' does not exist in response`,
        expected: 'exists',
        actual: matches.length > 0 ? matches : null,
      };
    }

    if (matches.length === 0) {
      return {
        type: 'json_path',
        passed: false,
        message: `JSONPath '${path}' not found in response`,
        expected: assertion.value,
        actual: null,
      };
    }

    const actualValue = matches[0];
    const expectedValue = assertion.value || '';

    let parsedExpected: unknown = expectedValue;
    try {
      parsedExpected = JSON.parse(expectedValue);
    } catch {
      // Keep as string
    }

    const passed = compareValues(actualValue, parsedExpected, assertion.operator);

    return {
      type: 'json_path',
      passed,
      message: passed
        ? `JSONPath '${path}' value ${getOperatorText(assertion.operator)} expected value`
        : `Expected JSONPath '${path}' to ${getOperatorText(assertion.operator)} '${expectedValue}', but got '${JSON.stringify(actualValue)}'`,
      expected: parsedExpected,
      actual: actualValue,
    };
  } catch (error) {
    return {
      type: 'json_path',
      passed: false,
      message: `Failed to parse JSON response: ${error instanceof Error ? error.message : 'Unknown error'}`,
      expected: assertion.value,
      actual: null,
    };
  }
};

const evaluateTextContains = (assertion: ApiAssertion, responseBody: string): AssertionResult => {
  const expectedText = assertion.value || '';
  let passed = false;

  switch (assertion.operator) {
    case 'contains':
      passed = responseBody.toLowerCase().includes(expectedText.toLowerCase());
      break;
    case 'not_contains':
      passed = !responseBody.toLowerCase().includes(expectedText.toLowerCase());
      break;
    case 'equals':
      passed = responseBody === expectedText;
      break;
    case 'not_equals':
      passed = responseBody !== expectedText;
      break;
    default:
      throw new Error(`Operator '${assertion.operator}' not supported for text_contains assertion`);
  }

  return {
    type: 'text_contains',
    passed,
    message: passed
      ? `Response body ${getOperatorText(assertion.operator)} '${expectedText}'`
      : `Expected response body to ${getOperatorText(assertion.operator)} '${expectedText}'`,
    expected: expectedText,
    actual: responseBody.substring(0, 200),
  };
};

const evaluateHeader = (assertion: ApiAssertion, headers: Record<string, string>): AssertionResult => {
  const headerName = assertion.path || '';
  const actualValue = headers[headerName] || headers[headerName.toLowerCase()];

  if (assertion.operator === 'exists') {
    const passed = !!actualValue;
    return {
      type: 'header',
      passed,
      message: passed
        ? `Header '${headerName}' exists`
        : `Header '${headerName}' does not exist`,
      expected: 'exists',
      actual: actualValue || null,
    };
  }

  const expectedValue = assertion.value || '';
  const passed = compareValues(actualValue, expectedValue, assertion.operator);

  return {
    type: 'header',
    passed,
    message: passed
      ? `Header '${headerName}' ${getOperatorText(assertion.operator)} expected value`
      : `Expected header '${headerName}' to ${getOperatorText(assertion.operator)} '${expectedValue}', but got '${actualValue || 'undefined'}'`,
    expected: expectedValue,
    actual: actualValue || null,
  };
};

const compareValues = (actual: any, expected: any, operator: string): boolean => {
  switch (operator) {
    // == / != on purpose: assertion `value` is stored as TEXT, so a numeric
    // status of 200 must match the string "200". Don't switch to ===.
    case 'equals':         return actual == expected;
    case 'not_equals':     return actual != expected;
    case 'greater_than':   return Number(actual) > Number(expected);
    case 'less_than':      return Number(actual) < Number(expected);
    case 'contains':       return String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case 'not_contains':   return !String(actual).toLowerCase().includes(String(expected).toLowerCase());
    case 'exists':         return actual !== null && actual !== undefined;
    default:               throw new Error(`Unknown operator: ${operator}`);
  }
};

const getOperatorText = (operator: string): string => {
  switch (operator) {
    case 'equals':         return 'equals';
    case 'not_equals':     return 'does not equal';
    case 'greater_than':   return 'is greater than';
    case 'less_than':      return 'is less than';
    case 'contains':       return 'contains';
    case 'not_contains':   return 'does not contain';
    case 'exists':         return 'exists';
    default:               return operator;
  }
};
