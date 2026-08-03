import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
export interface PlaywrightArtifact {
  name: string;
  path: string;
  contentType: string;
}

type PlaywrightJsonSuite = {
  specs?: Array<{
    title: string;
    tests?: Array<{ results: Array<Record<string, unknown>> }>;
  }>;
  suites?: PlaywrightJsonSuite[];
};

export function parsePlaywrightJsonOutput(stdout: string): Record<string, unknown> | undefined {
  try {
    const jsonStart = stdout.indexOf('{');
    const jsonEnd = stdout.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) return undefined;
    return JSON.parse(stdout.substring(jsonStart, jsonEnd + 1)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function flattenPlaywrightTests(
  suite: PlaywrightJsonSuite,
): Array<{ title: string; result: Record<string, unknown> }> {
  let tests: Array<{ title: string; result: Record<string, unknown> }> = [];
  if (suite.specs) {
    for (const spec of suite.specs) {
      if (spec.tests && spec.tests.length > 0 && spec.tests[0].results.length > 0) {
        tests.push({ title: spec.title, result: spec.tests[0].results[0] });
      }
    }
  }
  if (suite.suites) {
    for (const child of suite.suites) {
      tests = tests.concat(flattenPlaywrightTests(child));
    }
  }
  return tests;
}

function appendTestLogs(
  testRun: Record<string, unknown>,
  logs: string[],
  stripAnsi: (s: string) => string,
): void {
  const stdout = testRun.stdout as Array<{ text?: string }> | undefined;
  if (stdout) stdout.forEach((l) => logs.push(`[STDOUT] ${stripAnsi(String(l.text ?? ''))}`));
  const stderr = testRun.stderr as Array<{ text?: string }> | undefined;
  if (stderr) stderr.forEach((l) => logs.push(`[STDERR] ${stripAnsi(String(l.text ?? ''))}`));
}

function collectAttachments(
  testRun: Record<string, unknown>,
  artifacts: PlaywrightArtifact[],
): void {
  const attachments = testRun.attachments as
    | Array<{ path?: string; name?: string; contentType?: string }>
    | undefined;
  if (!Array.isArray(attachments)) return;
  for (const att of attachments) {
    if (!att?.path) continue;
    artifacts.push({
      name: String(att.name ?? 'attachment'),
      path: path.isAbsolute(att.path) ? att.path : path.resolve(process.cwd(), att.path),
      contentType: String(att.contentType ?? 'application/octet-stream'),
    });
  }
}

function processSinglePlaywrightTest(
  test: { title: string; result: Record<string, unknown> },
  logs: string[],
  artifacts: PlaywrightArtifact[],
  stripAnsi: (s: string) => string,
): string | undefined {
  const testRun = test.result;
  let executionError: string | undefined;
  if (testRun.status === 'passed') {
    logs.push(`✅ Test passed: ${test.title}`);
  } else {
    logs.push(`❌ Test failed: ${test.title}`);
    const err = testRun.error as { message?: string; snippet?: string } | undefined;
    if (err) {
      const cleanError = stripAnsi(String(err.message ?? ''));
      logs.push(`Error: ${cleanError}`);
      if (err.snippet) logs.push(stripAnsi(String(err.snippet)));
      executionError = cleanError;
    }
  }
  appendTestLogs(testRun, logs, stripAnsi);
  collectAttachments(testRun, artifacts);
  return executionError;
}

export function processPlaywrightSuite(
  parsedResult: Record<string, unknown>,
  logs: string[],
  artifacts: PlaywrightArtifact[],
): { success: boolean; executionError?: string } {
  const stripAnsi = stripVTControlCharacters;
  let success = true;
  let executionError: string | undefined;

  const suites = parsedResult.suites as PlaywrightJsonSuite[] | undefined;
  if (!suites?.length) return { success, executionError };

  const allTests = flattenPlaywrightTests(suites[0]);
  for (const test of allTests) {
    const err = processSinglePlaywrightTest(test, logs, artifacts, stripAnsi);
    if (err) executionError = err;
  }

  if (executionError) success = false;
  return { success, executionError };
}
