import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'node:path';

const execAsync = promisify(exec);

export interface PlaywrightArtifact {
  /** Logical name from Playwright: 'trace' | 'screenshot' | 'video' | etc. */
  name: string;
  /** Absolute path on disk after the run. Caller is responsible for upload + cleanup. */
  path: string;
  /** MIME type Playwright reported. */
  contentType: string;
}

export interface PlaywrightTestResult {
  success: boolean;
  error?: string;
  logs: string[];
  /**
   * Artifacts produced during the run. Populated when trace / screenshot
   * capture is enabled and the run actually emitted them — typically only
   * on failure for retain-on-failure / only-on-failure modes.
   */
  artifacts: PlaywrightArtifact[];
  duration_ms: number;
}

interface TestConfig {
  headless?: boolean;
  timeout?: number;
  viewport?: { width: number; height: number };
  /**
   * Absolute path Playwright should drop artifacts into (via `--output`).
   * When unset, Playwright defaults to `test-results/` which means parallel
   * runs collide. Callers should pass a per-run directory.
   */
  outputDir?: string;
}

/**
 * Run a Playwright `.spec.ts` against `playwright test`, capture artifacts
 * (trace + screenshots on failure), parse the JSON reporter output, and
 * return a structured result. Cleanup of `outputDir` is the caller's
 * responsibility — we don't delete it because the caller usually wants to
 * read artifact files first.
 */
export async function executePlaywrightTest(
  scriptPath: string,
  _targetUrl: string,
  _credentials?: Record<string, string>,
  config?: TestConfig,
): Promise<PlaywrightTestResult> {
  const logs: string[] = [];
  const startTime = Date.now();
  const artifacts: PlaywrightArtifact[] = [];

  try {
    logs.push(`Preparing to execute test via native Playwright runner...`);
    logs.push(`Script path: ${scriptPath}`);

    // Build the command. We need:
    //   --reporter json       parse-able output on stdout
    //   --trace retain-on-failure   write trace.zip when the test fails
    //   --output <dir>        deterministic artifact location per run
    // Screenshot on failure is the Playwright default when the testInfo
    // calls page.screenshot or the run records a step failure with a
    // page attached — for raw .spec.ts files we additionally rely on the
    // `screenshot: 'only-on-failure'` in playwright.config.ts.
    const outputArg = config?.outputDir ? ` --output "${config.outputDir}"` : '';
    const command = `npx playwright test "${scriptPath}" --reporter json --trace retain-on-failure${outputArg}`;

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
      stdout = e.stdout || '';
      stderr = e.stderr || '';
      executionError = e.message;
      success = false;
    }

    let parsedResult;
    try {
      const jsonStart = stdout.indexOf('{');
      const jsonEnd = stdout.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonStr = stdout.substring(jsonStart, jsonEnd + 1);
        parsedResult = JSON.parse(jsonStr);
      }
    } catch {
      logs.push('Failed to parse Playwright JSON output');
    }

    if (parsedResult?.suites?.length > 0) {
      const stripAnsi = (str: string) =>
        str.replace(
          /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
          '',
        );

      const flattenTests = (suite: any): any[] => {
        let tests: any[] = [];
        if (suite.specs) {
          suite.specs.forEach((spec: any) => {
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

        // Pull attachments. Playwright's JSON reporter emits one entry per
        // captured file (trace, screenshot, video). Names are stable enough
        // to route on. We resolve relative paths against cwd so the caller
        // gets absolutes.
        if (Array.isArray(testRun.attachments)) {
          for (const att of testRun.attachments) {
            if (!att?.path) continue;
            artifacts.push({
              name: String(att.name ?? 'attachment'),
              path: path.isAbsolute(att.path) ? att.path : path.resolve(process.cwd(), att.path),
              contentType: String(att.contentType ?? 'application/octet-stream'),
            });
          }
        }
      }

      if (executionError) success = false;
    } else {
      if (!success) {
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
      artifacts,
      duration_ms: Date.now() - startTime,
    };
  } catch (error: any) {
    logs.push(`System Error: ${error.message}`);
    return {
      success: false,
      error: error.message,
      logs,
      artifacts: [],
      duration_ms: Date.now() - startTime,
    };
  }
}
