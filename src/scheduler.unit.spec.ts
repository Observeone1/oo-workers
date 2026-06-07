import { describe, test, expect } from 'bun:test';
import { makeNonce, jobIdSuffix, buildJobId } from './scheduler-jobid.ts';

describe('makeNonce', () => {
  test('is exactly 4 characters', () => {
    for (let i = 0; i < 20; i++) expect(makeNonce()).toHaveLength(4);
  });

  test('contains only lowercase letters and digits', () => {
    for (let i = 0; i < 20; i++) expect(makeNonce()).toMatch(/^[a-z0-9]{4}$/);
  });

  test('two calls produce distinct nonces (with overwhelming probability)', () => {
    const seen = new Set(Array.from({ length: 50 }, () => makeNonce()));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('jobIdSuffix', () => {
  test('master path (no region) returns empty string', () => {
    expect(jobIdSuffix({ regionId: null, regionSlug: null })).toBe('');
  });

  test('agent path returns -r<regionId>', () => {
    expect(jobIdSuffix({ regionId: 3, regionSlug: 'east' })).toBe('-r3');
    expect(jobIdSuffix({ regionId: 99, regionSlug: 'us-west' })).toBe('-r99');
  });
});

describe('buildJobId', () => {
  const TYPES = ['url', 'api', 'tcp', 'udp', 'db', 'tls', 'qa'] as const;
  const bucket = 12345;
  const nonce = 'ab12';
  const master = { regionId: null, regionSlug: null };
  const agent = { regionId: 3, regionSlug: 'east' };

  test('master-path ID has exactly 2 colons (BullMQ 3-part contract)', () => {
    for (const t of TYPES) {
      const id = buildJobId(t, 1, bucket, master, nonce);
      expect(id.split(':').length).toBe(3);
    }
  });

  test('agent-path ID also has exactly 2 colons', () => {
    for (const t of TYPES) {
      const id = buildJobId(t, 1, bucket, agent, nonce);
      expect(id.split(':').length).toBe(3);
      expect(id.endsWith('-r3')).toBe(true);
    }
  });

  test('different nonces produce different IDs for same monitor + bucket', () => {
    const id1 = buildJobId('url', 1, bucket, master, 'abcd');
    const id2 = buildJobId('url', 1, bucket, master, 'efgh');
    expect(id1).not.toBe(id2);
  });

  test('ID structure is <type>:<monitorId>:<bucket>-<nonce>[suffix]', () => {
    const id = buildJobId('url', 42, bucket, master, nonce);
    expect(id).toBe(`url:42:${bucket}-${nonce}`);

    const agentId = buildJobId('tcp', 7, bucket, agent, nonce);
    expect(agentId).toBe(`tcp:7:${bucket}-${nonce}-r3`);
  });
});
