/**
 * signedFetchRaw body handling — the three request shapes the S3 client
 * emits: a bodyless request, a buffered PUT, and a streamed PUT.
 *
 * The distinction is not cosmetic. A streamed PUT cannot be hashed up
 * front, so Sig-V4 requires the literal UNSIGNED-PAYLOAD marker in
 * x-amz-content-sha256 (and the signature over it); sending a real hash
 * there, or omitting Bun's duplex:'half', makes the server reject the
 * upload. Header ordering has its own regression guard in
 * object-storage-signing.regression.unit.spec.ts.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { signedFetchRaw } from './object-storage-signing.ts';

const realFetch = globalThis.fetch;

interface Captured {
  url?: string;
  init?: RequestInit & { duplex?: string };
}

/** Swap fetch for a recorder and hand back what the signer sent. */
function captureFetch(): Captured {
  const captured: Captured = {};
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init as Captured['init'];
    return new Response('ok');
  }) as typeof fetch;
  return captured;
}

function headersOf(c: Captured): Record<string, string> {
  return (c.init?.headers ?? {}) as Record<string, string>;
}

const sign = (method: 'GET' | 'PUT' | 'DELETE', body: Buffer | ReadableStream<Uint8Array> | null) =>
  signedFetchRaw(
    method,
    new URL('https://bucket.example.test/artifacts/run-1.zip'),
    body,
    'AKIA_TEST',
    'SECRET_TEST',
    'eu-test-1',
  );

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('signedFetchRaw request bodies', () => {
  test('a bodyless request sends no body and hashes the empty payload', async () => {
    const captured = captureFetch();

    await sign('DELETE', null);

    expect(captured.init?.body).toBeUndefined();
    expect(captured.init?.duplex).toBeUndefined();
    expect(captured.init?.method).toBe('DELETE');
    // sha256 of zero bytes — the Sig-V4 empty-payload constant.
    expect(headersOf(captured)['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('a buffered PUT is sent as a blob hashed with its real contents', async () => {
    const captured = captureFetch();
    const payload = Buffer.from('report-bytes');

    await sign('PUT', payload);

    expect(captured.init?.duplex).toBeUndefined();
    expect(headersOf(captured)['x-amz-content-sha256']).toBe(
      createHash('sha256').update(payload).digest('hex'),
    );
    expect(captured.init?.body).toBeInstanceOf(Blob);
    expect(await (captured.init?.body as Blob).text()).toBe('report-bytes');
  });

  test('a streamed PUT is unsigned-payload and carries duplex:half', async () => {
    const captured = captureFetch();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed-bytes'));
        controller.close();
      },
    });

    await sign('PUT', stream);

    // Streams cannot be hashed up front: the marker, not a digest.
    expect(headersOf(captured)['x-amz-content-sha256']).toBe('UNSIGNED-PAYLOAD');
    expect(captured.init?.duplex).toBe('half');
    expect(captured.init?.body).toBe(stream);
  });

  test('the payload hash is what actually gets signed', async () => {
    const captured = captureFetch();

    await sign('PUT', Buffer.from('a'));
    const bufferedAuth = headersOf(captured).Authorization;

    await sign(
      'PUT',
      new ReadableStream<Uint8Array>({
        start: (c) => {
          c.close();
        },
      }),
    );
    const streamedAuth = headersOf(captured).Authorization;

    // Same key, region and path: only the payload hash differs, so the
    // signatures must differ too (a shared signature would mean the body
    // never entered the canonical request).
    expect(bufferedAuth).not.toBe(streamedAuth);
  });
});
