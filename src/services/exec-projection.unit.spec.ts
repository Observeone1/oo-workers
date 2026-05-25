/**
 * Unit tests for projectStalled — the read-time stalled-execution
 * projection. Locks the contract before / after the master-path fix.
 */

import { describe, test, expect } from 'bun:test';
import { projectStalled } from './exec-projection.ts';

const NOW = Date.now();
const FRESH = new Date(NOW - 10_000); // 10s ago
const STALE = new Date(NOW - 5 * 60 * 1000); // 5 min ago

describe('projectStalled', () => {
  test('PENDING + stale (regional) → FAILED with synthetic message', () => {
    const out = projectStalled({ status: 'PENDING', regionId: 7, errorMessage: null }, STALE, 60);
    expect(out.status).toBe('FAILED');
    expect(out.errorMessage).toMatch(/stalled/i);
  });

  test('PENDING + stale (master-path, regionId=null) → also FAILED (bug fix)', () => {
    // Before the fix this returned the row unchanged because of an
    // `|| regionId === null` short-circuit. Master-path stalls now project.
    const out = projectStalled(
      { status: 'PENDING', regionId: null, errorMessage: null },
      STALE,
      60,
    );
    expect(out.status).toBe('FAILED');
    expect(out.errorMessage).toMatch(/stalled/i);
  });

  test('PENDING + fresh (under 2× interval) → unchanged', () => {
    const row = { status: 'PENDING', regionId: null, errorMessage: null };
    const out = projectStalled(row, FRESH, 60);
    expect(out).toEqual(row);
  });

  test('PENDING just under 2× interval → unchanged; just over → FAILED', () => {
    const justUnder = new Date(Date.now() - (60 * 2 - 5) * 1000); // 5s shy of 2× of 60s
    const justOver = new Date(Date.now() - (60 * 2 + 5) * 1000); // 5s past 2× of 60s
    const row = { status: 'PENDING', regionId: null, errorMessage: null };
    expect(projectStalled(row, justUnder, 60).status).toBe('PENDING');
    expect(projectStalled(row, justOver, 60).status).toBe('FAILED');
  });

  test('SUCCESS row → unchanged regardless of age', () => {
    const row = { status: 'SUCCESS', regionId: 1, errorMessage: null };
    const out = projectStalled(row, STALE, 60);
    expect(out).toEqual(row);
  });

  test('FAILED row → unchanged regardless of age', () => {
    const row = { status: 'FAILED', regionId: null, errorMessage: 'real failure' };
    const out = projectStalled(row, STALE, 60);
    expect(out).toEqual(row);
  });

  test('null startTime → unchanged (no signal to age against)', () => {
    const row = { status: 'PENDING', regionId: null, errorMessage: null };
    const out = projectStalled(row, null, 60);
    expect(out).toEqual(row);
  });

  test('ISO-string startTime is parsed the same as a Date', () => {
    const iso = STALE.toISOString();
    const out = projectStalled({ status: 'PENDING', regionId: 2, errorMessage: null }, iso, 60);
    expect(out.status).toBe('FAILED');
  });

  test('preserves an existing errorMessage instead of overwriting it', () => {
    const out = projectStalled(
      { status: 'PENDING', regionId: null, errorMessage: 'queue picked up but never finished' },
      STALE,
      60,
    );
    expect(out.status).toBe('FAILED');
    expect(out.errorMessage).toBe('queue picked up but never finished');
  });
});
