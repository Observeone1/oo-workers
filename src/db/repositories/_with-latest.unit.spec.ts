/**
 * Unit tests for projectLatest — the shared `latest`-execution projection
 * helper reused by every monitor repo's findAllWithLatest(). Covers the
 * null/no-execution short-circuits and that staleness projection (via
 * projectStalled) is correctly threaded into the shape callback.
 */

import { describe, test, expect } from 'bun:test';
import { projectLatest, type LatestExecutionInput } from './_with-latest.ts';

const NOW = Date.now();
const FRESH = new Date(NOW - 10_000); // 10s ago
const STALE = new Date(NOW - 5 * 60 * 1000); // 5 min ago

interface Row extends LatestExecutionInput {
  latencyMs: number | null;
}

describe('projectLatest', () => {
  test('returns null when the latest row is null', () => {
    const out = projectLatest<Row, unknown>(null, 60, (l, projected) => ({ l, projected }));
    expect(out).toBeNull();
  });

  test('returns null when the leftJoin produced no execution (id === null)', () => {
    const row: Row = {
      id: null,
      status: 'PENDING',
      regionId: null,
      errorMessage: null,
      startTime: FRESH,
      latencyMs: null,
    };
    const out = projectLatest<Row, unknown>(row, 60, (l, projected) => ({ l, projected }));
    expect(out).toBeNull();
  });

  test('shapes a fresh SUCCESS row unchanged', () => {
    const row: Row = {
      id: 1,
      status: 'SUCCESS',
      regionId: 3,
      errorMessage: null,
      startTime: FRESH,
      latencyMs: 120,
    };
    const out = projectLatest(row, 60, (l, projected) => ({
      latencyMs: l.latencyMs,
      status: projected.status,
      errorMessage: projected.errorMessage,
    }));
    expect(out).toEqual({ latencyMs: 120, status: 'SUCCESS', errorMessage: null });
  });

  test('projects a stalled PENDING row to FAILED with a synthetic message', () => {
    const row: Row = {
      id: 2,
      status: 'PENDING',
      regionId: null,
      errorMessage: null,
      startTime: STALE,
      latencyMs: null,
    };
    const out = projectLatest(row, 60, (l, projected) => ({
      id: l.id,
      status: projected.status,
      errorMessage: projected.errorMessage,
    }));
    expect(out?.status).toBe('FAILED');
    expect(out?.errorMessage).toMatch(/stalled/i);
    expect(out?.id).toBe(2);
  });

  test('leaves a fresh PENDING row (under 2x interval) unprojected', () => {
    const row: Row = {
      id: 3,
      status: 'PENDING',
      regionId: null,
      errorMessage: null,
      startTime: FRESH,
      latencyMs: null,
    };
    const out = projectLatest(row, 60, (l, projected) => projected.status);
    expect(out).toBe('PENDING');
  });

  test('passes the original row through to the shape callback unmodified', () => {
    const row: Row = {
      id: 4,
      status: 'FAILED',
      regionId: 1,
      errorMessage: 'boom',
      startTime: STALE,
      latencyMs: 999,
    };
    const out = projectLatest(row, 60, (l) => l);
    expect(out).toEqual(row);
  });
});
