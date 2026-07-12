/**
 * Unit test for the cached package-version lookup shared by the master
 * (X-Agent-Version comparison) and the agent (poll header). Reads the real
 * package.json on disk — no mocking needed, it's a plain sync file read.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { packageVersion } from './version.ts';

describe('packageVersion', () => {
  test('returns the version from package.json', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(packageVersion()).toBe(pkg.version);
  });

  test('returns a semver-looking string', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('is stable across repeated calls (cached)', () => {
    expect(packageVersion()).toBe(packageVersion());
  });
});
