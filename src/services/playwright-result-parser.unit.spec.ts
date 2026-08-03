import { describe, expect, test } from 'bun:test';
import { processPlaywrightSuite } from './playwright-result-parser.ts';

describe('playwright-result-parser', () => {
  test('processPlaywrightSuite records pass/fail and artifacts', () => {
    const logs: string[] = [];
    const artifacts: Array<{ name: string; path: string; contentType: string }> = [];
    const parsed = {
      suites: [
        {
          specs: [
            {
              title: 'ok test',
              tests: [{ results: [{ status: 'passed', stdout: [], stderr: [], attachments: [] }] }],
            },
            {
              title: 'bad test',
              tests: [
                {
                  results: [
                    {
                      status: 'failed',
                      error: { message: 'boom' },
                      stdout: [{ text: 'line' }],
                      stderr: [],
                      attachments: [
                        { name: 'shot', path: 'out/shot.png', contentType: 'image/png' },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const result = processPlaywrightSuite(parsed, logs, artifacts);
    expect(result.success).toBe(false);
    expect(result.executionError).toBe('boom');
    expect(logs.some((l) => l.includes('ok test'))).toBe(true);
    expect(logs.some((l) => l.includes('bad test'))).toBe(true);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe('shot');
  });
});
