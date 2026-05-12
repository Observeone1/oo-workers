import { exec } from 'child_process';
import { logger } from '../utils/logger.ts';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface PlaywrightTestResult {
  success: boolean;
  error?: string;
  logs: string[];
  screenshotPath?: string;
  duration_ms: number;
}

interface TestConfig {
  headless?: boolean;
  timeout?: number;
  viewport?: { width: number; height: number };
}

/**
 * Execute a Playwright test script using the native Playwright runner
 *
 * Strategy:
 * 1. Receive path to the .spec.ts file
 * 2. Run 'npx playwright test <path>' via child_process
 * 3. Parse the JSON output for results
 */
export async function executePlaywrightTest(
  scriptPath: string,
  targetUrl: string, // Not directly used in native mode unless injected into script
  credentials?: Record<string, string>, // Would need to be injected or handled via env vars
  config?: TestConfig,
): Promise<PlaywrightTestResult> {
  const logs: string[] = [];
  const startTime = Date.now();

  try {
    logs.push(`Preparing to execute test via native Playwright runner...`);
    logs.push(`Script path: ${scriptPath}`);

    // Construct command
    // Use JSON reporter to easily parse results
    const command = `npx playwright test "${scriptPath}" --reporter json`;

    logs.push(`Executing: ${command}`);

    let stdout = '';
    let stderr = '';
    let success = false;
    let executionError: string | undefined;

    try {
      const result = await execAsync(command, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PLAYWRIGHT_HEADLESS: 'true',
        },
      });
      stdout = result.stdout;
      stderr = result.stderr;
      success = true;
    } catch (e: any) {
      // execAsync throws on non-zero exit code (test failure)
      stdout = e.stdout || '';
      stderr = e.stderr || '';
      executionError = e.message;
      success = false;
    }

    // Parse JSON output
    let parsedResult;
    try {
      // Attempt to find the JSON block in stdout
      const jsonStart = stdout.indexOf('{');
      const jsonEnd = stdout.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonStr = stdout.substring(jsonStart, jsonEnd + 1);
        parsedResult = JSON.parse(jsonStr);
      }
    } catch (parseError) {
      logs.push('Failed to parse Playwright JSON output');
    }

    // Process results
    if (parsedResult?.suites?.length > 0) {
      // Aggregate logs and status
      // The suite structure follows the file path -> nested suites -> tests

      // Helper to strip ANSI codes
      const stripAnsi = (str: string) =>
        str.replace(
          /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
          '',
        );

      // Helper to extract tests recursively
      const flattenTests = (suite: any): any[] => {
        let tests: any[] = [];
        if (suite.specs) {
          suite.specs.forEach((spec: any) => {
            // Check if specs have tests and results
            if (spec.tests && spec.tests.length > 0 && spec.tests[0].results.length > 0) {
              tests.push({ title: spec.title, result: spec.tests[0].results[0] });
            }
          });
        }
        if (suite.suites) {
          suite.suites.forEach((child: any) => {
            tests = tests.concat(flattenTests(child));
          });
        }
        return tests;
      };

      const allTests = flattenTests(parsedResult.suites[0]);

      for (const test of allTests) {
        const testRun = test.result;

        if (testRun.status === 'passed') {
          logs.push(`✅ Test passed: ${test.title}`);
        } else {
          logs.push(`❌ Test failed: ${test.title}`);
          if (testRun.error) {
            const cleanError = stripAnsi(testRun.error.message);
            logs.push(`Error: ${cleanError}`);
            if (testRun.error.snippet) logs.push(stripAnsi(testRun.error.snippet));
            executionError = cleanError;
          }
        }

        if (testRun.stdout) {
          testRun.stdout.forEach((l: any) => logs.push(`[STDOUT] ${stripAnsi(l.text)}`));
        }
        if (testRun.stderr) {
          testRun.stderr.forEach((l: any) => logs.push(`[STDERR] ${stripAnsi(l.text)}`));
        }
      }

      // If execution didn't throw but tests failed, success is false
      if (executionError) success = false;
    } else {
      // Fallback if parsing failed or no suites found
      if (!success) {
        // Also strip ANSI from stderr if capturing raw output
        const cleanStderr = stderr.replace(
          /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
          '',
        );
        logs.push(`Execution failed: ${executionError}`);
        logs.push(`STDERR: ${cleanStderr}`);
      }
    }

    return {
      success,
      error: executionError,
      logs,
      duration_ms: Date.now() - startTime,
    };
  } catch (error: any) {
    logs.push(`System Error: ${error.message}`);
    return {
      success: false,
      error: error.message,
      logs,
      duration_ms: Date.now() - startTime,
    };
  }
}
