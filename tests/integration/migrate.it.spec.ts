/**
 * src/db/migrate.ts — runMigrations() itself is already exercised by every
 * IT spec through createTestDb() (which always has pending migrations to
 * apply on a brand-new database). What's missing is the "nothing pending"
 * idempotency branch and the main() CLI entry — both real, untested code.
 *
 * The `if (import.meta.main)` wrapper is intentionally left untested: it
 * only runs when this file is bun's actual entry point (`bun
 * src/db/migrate.ts`), which an imported test process cannot simulate, and
 * bun's coverage instrumentation doesn't attach to the subprocesses that
 * backup-restore.it.spec.ts already spawns to exercise it behaviorally.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { runMigrations, main } from '../../src/db/migrate.ts';
import { createTestDb } from './_harness.ts';

const drops: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const drop of drops) await drop().catch(() => {});
});

describe('runMigrations — idempotency', () => {
  test('a second run against an already-migrated database applies nothing and logs up to date', async () => {
    const { databaseUrl, dropDb } = await createTestDb();
    drops.push(dropDb);

    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args);
    try {
      await runMigrations(databaseUrl);
    } finally {
      console.log = originalLog;
    }

    expect(logs.some((l) => l[0] === 'schema up to date')).toBe(true);
    expect(logs.some((l) => String(l[0]).startsWith('applying'))).toBe(false);
  });
});

describe('main() — CLI entry', () => {
  test('exits 1 and logs an error when DATABASE_URL is unset', async () => {
    const originalUrl = process.env.DATABASE_URL;
    const originalExit = process.exit;
    const originalError = console.error;
    const errors: unknown[][] = [];
    delete (process.env as Record<string, string | undefined>).DATABASE_URL;
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never;
    console.error = (...args: unknown[]) => errors.push(args);

    try {
      await expect(main()).rejects.toThrow('exit:1');
      expect(errors[0]?.[0]).toBe('DATABASE_URL is required');
    } finally {
      process.exit = originalExit;
      console.error = originalError;
      if (originalUrl !== undefined) process.env.DATABASE_URL = originalUrl;
    }
  });

  test('reads DATABASE_URL from env and runs migrations successfully', async () => {
    const { databaseUrl, dropDb } = await createTestDb();
    drops.push(dropDb);
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;

    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args);
    try {
      await expect(main()).resolves.toBeUndefined();
      expect(logs.some((l) => l[0] === 'schema up to date')).toBe(true);
    } finally {
      console.log = originalLog;
      if (originalUrl !== undefined) process.env.DATABASE_URL = originalUrl;
      else delete (process.env as Record<string, string | undefined>).DATABASE_URL;
    }
  });
});
