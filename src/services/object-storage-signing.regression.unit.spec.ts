import { afterEach, describe, expect, test } from 'bun:test';

import { signedFetchRaw } from './object-storage-signing.ts';

// Regression guard for the S2871 fix: canonical header sorting must stay
// byte-order (Sig-V4 contract). Locks the ordering so a future "cleanup" to
// localeCompare (locale-dependent, reorders hyphenated names under ICU)
// would fail here instead of producing signatures the server rejects.
describe('signedFetchRaw canonical header ordering', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('SignedHeaders is byte-order sorted, extra headers included', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response('ok');
    }) as typeof fetch;

    const res = await signedFetchRaw(
      'GET',
      new URL('https://bucket.example.test/key?b=2&a=1'),
      null,
      'AKIA_TEST',
      'SECRET_TEST',
      'eu-test-1',
      { 'zz-custom': 'v1', 'aa-custom': 'v2', 'x-amz-meta-run': 'v3' },
    );

    expect(await res.text()).toBe('ok');
    const auth = capturedHeaders?.Authorization ?? '';
    const signed = /SignedHeaders=([^,]+),/.exec(auth)?.[1];
    expect(signed).toBe('aa-custom;host;x-amz-content-sha256;x-amz-date;x-amz-meta-run;zz-custom');
  });
});
