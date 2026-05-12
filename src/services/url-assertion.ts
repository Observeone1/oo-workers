import { logger } from '../utils/logger.ts';

export interface UrlMonitorAssertion {
  id?: number;
  urlMonitorId?: number;
  operator: 'equals' | 'not_equals' | 'less_than' | 'greater_than';
  statusCode: number;
}

export interface UrlMonitorAssertionResult {
  operator: string;
  passed: boolean;
  message: string;
  expected?: number;
  actual?: number;
}

const compareValues = (actual: any, expected: any, operator: string): boolean => {
  switch (operator) {
    // == / != on purpose: assertion `value` is stored as TEXT, so a numeric
    // status of 200 must match the string "200". Don't switch to ===.
    case 'equals':
      return actual == expected;

    case 'not_equals':
      return actual != expected;

    case 'greater_than':
      return Number(actual) > Number(expected);

    case 'less_than':
      return Number(actual) < Number(expected);

    default:
      throw new Error(`Unknown operator: ${operator}`);
  }
};

const getOperatorText = (operator: string): string => {
  switch (operator) {
    case 'equals':
      return 'equals';
    case 'not_equals':
      return 'does not equal';
    case 'greater_than':
      return 'is greater than';
    case 'less_than':
      return 'is less than';
    default:
      return operator;
  }
};

/**
 * Evaluate URL monitor assertions (status code only).
 */
export const evaluateUrlMonitorAssertions = (
  assertions: UrlMonitorAssertion[],
  actualStatusCode: number,
): UrlMonitorAssertionResult[] => {
  return assertions.map((assertion) => {
    try {
      const { operator, statusCode: expectedStatusCode } = assertion;
      const passed = compareValues(actualStatusCode, expectedStatusCode, operator);

      return {
        operator,
        passed,
        message: passed
          ? `Status code ${actualStatusCode} ${getOperatorText(operator)} ${expectedStatusCode}`
          : `Expected status code to ${getOperatorText(operator)} ${expectedStatusCode}, but got ${actualStatusCode}`,
        expected: expectedStatusCode,
        actual: actualStatusCode,
      };
    } catch (error) {
      logger.error(
        `Error evaluating URL monitor assertion: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        operator: assertion.operator,
        passed: false,
        message: `Error evaluating assertion: ${error instanceof Error ? error.message : 'Unknown error'}`,
        expected: assertion.statusCode,
        actual: actualStatusCode,
      };
    }
  });
};
