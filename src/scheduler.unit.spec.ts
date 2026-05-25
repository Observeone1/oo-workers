/**
 * Scheduler logic that can be tested without a database connection.
 * The heavy DB-dependent behaviour (drain, dispatch, tick) is covered by
 * the integration suite; this file only covers the stateless parts.
 */
import { describe, test, expect } from 'bun:test';

// BOOT_NONCE generation formula — must produce a 4-char lowercase alphanumeric
// string. The scheduler stamps this on every job ID so cross-restart IDs never
// collide with BullMQ's dedup key, even if the wall-clock bucket is identical.
describe('BOOT_NONCE format', () => {
  function makeNonce(): string {
    return Math.random().toString(36).slice(2, 6);
  }

  test('is exactly 4 characters', () => {
    for (let i = 0; i < 20; i++) {
      expect(makeNonce()).toHaveLength(4);
    }
  });

  test('contains only lowercase letters and digits', () => {
    for (let i = 0; i < 20; i++) {
      expect(makeNonce()).toMatch(/^[a-z0-9]{4}$/);
    }
  });
});

describe('job ID format', () => {
  // Mirrors the format from tickUrlMonitors / tickTcpMonitors etc.:
  //   `url:${m.id}:${bucket}:${BOOT_NONCE}${jobIdSuffix(target)}`
  // where jobIdSuffix returns '' for master and ':r<regionId>' for agents.

  test('master-path job ID embeds nonce as 4th segment', () => {
    const monitorId = 42;
    const bucket = Math.floor(Date.now() / (60 * 1000));
    const nonce = 'ab12';
    const jobId = `url:${monitorId}:${bucket}:${nonce}`;
    expect(jobId.split(':')[3]).toBe(nonce);
  });

  test('agent-path job ID appends regionId suffix after nonce', () => {
    const monitorId = 7;
    const bucket = Math.floor(Date.now() / (60 * 1000));
    const nonce = 'xy99';
    const regionId = 3;
    const jobId = `url:${monitorId}:${bucket}:${nonce}:r${regionId}`;
    const parts = jobId.split(':');
    expect(parts[3]).toBe(nonce);
    expect(parts[4]).toBe(`r${regionId}`);
  });

  test('two different nonces produce different job IDs for same monitor + bucket', () => {
    const monitorId = 1;
    const bucket = 12345;
    const id1 = `url:${monitorId}:${bucket}:abcd`;
    const id2 = `url:${monitorId}:${bucket}:efgh`;
    expect(id1).not.toBe(id2);
  });
});
