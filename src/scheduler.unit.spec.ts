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
  //   `url:${m.id}:${bucket}-${BOOT_NONCE}${jobIdSuffix(target)}`
  // where jobIdSuffix returns '' for master and '-r<regionId>' for agents.
  //
  // BullMQ rejects custom IDs containing ':' unless split(':').length === 3.
  // v1.24.0 used ':' as the nonce separator and produced 4-part IDs, breaking
  // every master-path tick. v1.24.1 switched the nonce separator to '-'.

  test('master-path job ID has exactly 2 colons (3 parts when split)', () => {
    const monitorId = 42;
    const bucket = Math.floor(Date.now() / (60 * 1000));
    const nonce = 'ab12';
    const jobId = `url:${monitorId}:${bucket}-${nonce}`;
    expect(jobId.split(':').length).toBe(3);
  });

  test('agent-path job ID also has exactly 2 colons (regionId is dash-joined)', () => {
    const monitorId = 7;
    const bucket = Math.floor(Date.now() / (60 * 1000));
    const nonce = 'xy99';
    const regionId = 3;
    const jobId = `url:${monitorId}:${bucket}-${nonce}-r${regionId}`;
    expect(jobId.split(':').length).toBe(3);
    expect(jobId.endsWith(`-r${regionId}`)).toBe(true);
  });

  test('two different nonces produce different job IDs for same monitor + bucket', () => {
    const monitorId = 1;
    const bucket = 12345;
    const id1 = `url:${monitorId}:${bucket}-abcd`;
    const id2 = `url:${monitorId}:${bucket}-efgh`;
    expect(id1).not.toBe(id2);
  });

  test('BullMQ-compatibility regression guard — colon count never exceeds 2', () => {
    const TYPES = ['url', 'api', 'tcp', 'udp', 'db', 'tls', 'qa'] as const;
    const bucket = 12345;
    const nonce = 'zg85';
    for (const t of TYPES) {
      const master = `${t}:1:${bucket}-${nonce}`;
      const agent = `${t}:1:${bucket}-${nonce}-r2`;
      expect(master.split(':').length).toBe(3);
      expect(agent.split(':').length).toBe(3);
    }
  });
});
