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

export interface UrlMonitorAssertion {
    id?: number;
    url_monitor_id: number;
    operator: 'equals' | 'not_equals' | 'less_than' | 'greater_than';
    status_code: number;
    created_at?: Date;
}

export interface UrlMonitorAssertionResult {
    operator: string;
    passed: boolean;
    message: string;
    expected?: number;
    actual?: number;
}

/**
 * Evaluate all assertions against API check response
 */
export const evaluateAssertions = async (
    assertions: ApiAssertion[],
    responseData: {
        status: number;
        responseTime: number;
        body: string;
        headers: Record<string, string>;
    }
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
                actual: null
            });
        }
    }

    return results;
};

/**
 * Evaluate a single assertion
 */
const evaluateAssertion = async (
    assertion: ApiAssertion,
    responseData: {
        status: number;
        responseTime: number;
        body: string;
        headers: Record<string, string>;
    }
): Promise<AssertionResult> => {
    switch (assertion.type) {
        case 'status_code':
            return evaluateStatusCode(assertion, responseData.status);

        case 'response_time':
            return evaluateResponseTime(assertion, responseData.responseTime);

        case 'json_path':
            return evaluateJsonPath(assertion, responseData.body);

        case 'text_contains':
            return evaluateTextContains(assertion, responseData.body);

        case 'header':
            return evaluateHeader(assertion, responseData.headers);

        default:
            throw new Error(`Unknown assertion type: ${assertion.type}`);
    }
};

/**
 * Evaluate status code assertion
 */
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
        actual: actualStatus
    };
};

/**
 * Evaluate response time assertion
 */
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
        actual: actualTime
    };
};

/**
 * Evaluate JSON path assertion
 */
const evaluateJsonPath = (assertion: ApiAssertion, responseBody: string): AssertionResult => {
    try {
        const json = JSON.parse(responseBody);
        const path = assertion.path || '$';

        // Extract value using JSONPath
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
                actual: matches.length > 0 ? matches : null
            };
        }

        if (matches.length === 0) {
            return {
                type: 'json_path',
                passed: false,
                message: `JSONPath '${path}' not found in response`,
                expected: assertion.value,
                actual: null
            };
        }

        const actualValue = matches[0];
        const expectedValue = assertion.value || '';

        // Try to parse expected value as JSON if possible
        let parsedExpected = expectedValue;
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
            actual: actualValue
        };
    } catch (error) {
        return {
            type: 'json_path',
            passed: false,
            message: `Failed to parse JSON response: ${error instanceof Error ? error.message : 'Unknown error'}`,
            expected: assertion.value,
            actual: null
        };
    }
};

/**
 * Evaluate text contains assertion
 */
const evaluateTextContains = (assertion: ApiAssertion, responseBody: string): AssertionResult => {
    const expectedText = assertion.value || '';
    const actualText = responseBody.toLowerCase();
    const searchText = expectedText.toLowerCase();

    let passed = false;

    switch (assertion.operator) {
        case 'contains':
            passed = actualText.includes(searchText);
            break;
        case 'not_contains':
            passed = !actualText.includes(searchText);
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
        actual: responseBody.substring(0, 200) // Limit actual value for readability
    };
};

/**
 * Evaluate header assertion
 */
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
            actual: actualValue || null
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
        actual: actualValue || null
    };
};

/**
 * Compare two values based on operator
 */
const compareValues = (actual: any, expected: any, operator: string): boolean => {
    switch (operator) {
        case 'equals':
            return actual == expected;

        case 'not_equals':
            return actual != expected;

        case 'greater_than':
            return Number(actual) > Number(expected);

        case 'less_than':
            return Number(actual) < Number(expected);

        case 'contains':
            return String(actual).toLowerCase().includes(String(expected).toLowerCase());

        case 'not_contains':
            return !String(actual).toLowerCase().includes(String(expected).toLowerCase());

        case 'exists':
            return actual !== null && actual !== undefined;

        default:
            throw new Error(`Unknown operator: ${operator}`);
    }
};

/**
 * Get human-readable operator text
 */
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
        case 'contains':
            return 'contains';
        case 'not_contains':
            return 'does not contain';
        case 'exists':
            return 'exists';
        default:
            return operator;
    }
};

/**
 * Evaluate URL monitor assertions (status code only)
 */
export const evaluateUrlMonitorAssertions = (
    assertions: UrlMonitorAssertion[],
    actualStatusCode: number
): UrlMonitorAssertionResult[] => {
    return assertions.map(assertion => {
        try {
            const { operator, status_code: expectedStatusCode } = assertion;
            const passed = compareValues(actualStatusCode, expectedStatusCode, operator);

            return {
                operator,
                passed,
                message: passed
                    ? `Status code ${actualStatusCode} ${getOperatorText(operator)} ${expectedStatusCode}`
                    : `Expected status code to ${getOperatorText(operator)} ${expectedStatusCode}, but got ${actualStatusCode}`,
                expected: expectedStatusCode,
                actual: actualStatusCode
            };
        } catch (error) {
            logger.error(`Error evaluating URL monitor assertion: ${error instanceof Error ? error.message : String(error)}`);
            return {
                operator: assertion.operator,
                passed: false,
                message: `Error evaluating assertion: ${error instanceof Error ? error.message : 'Unknown error'}`,
                expected: assertion.status_code,
                actual: actualStatusCode
            };
        }
    });
};
