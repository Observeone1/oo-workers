/**
 * AWS Signature V4 primitives + low-level signed fetch.
 * Used exclusively by object-storage.ts — not a general-purpose module.
 */

import { createHash, createHmac } from 'node:crypto';

function hex(buf: Buffer): string {
  return buf.toString('hex');
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac('AWS4' + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Sign + execute any S3 request given a pre-built URL.
 * - `body: Buffer | null` → standard signed PUT/GET/DELETE.
 * - `body: ReadableStream` → streaming PUT with UNSIGNED-PAYLOAD content-sha,
 *   so we don't buffer the whole body to compute its hash. Required for the
 *   agent→master→RustFS artifact proxy where bodies can be 50+ MB.
 */
export async function signedFetchRaw(
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
  url: URL,
  body: Buffer | ReadableStream<Uint8Array> | null,
  accessKey: string,
  secretKey: string,
  region: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const isStream = body !== null && typeof (body as ReadableStream).getReader === 'function';
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = isStream
    ? 'UNSIGNED-PAYLOAD'
    : sha256Hex((body as Buffer | null) ?? Buffer.alloc(0));

  const baseHeaders: Record<string, string> = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };

  const sortedKeys = Object.keys(baseHeaders)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = sortedKeys
    .map((k) => {
      const orig = Object.keys(baseHeaders).find((h) => h.toLowerCase() === k)!;
      return `${k}:${String(baseHeaders[orig]).trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  const signedHeaders = sortedKeys.join(';');

  // AWS Sig-V4 canonical query string: sorted by key, percent-encoded.
  // Caller can pass the URL with params in any order; we canonicalize here.
  const qs = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const canonicalRequest = [
    method,
    url.pathname,
    qs,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kSigning = signingKey(secretKey, dateStamp, region, 's3');
  const signature = hex(hmac(kSigning, stringToSign));
  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  if (method !== 'PUT' || body === null) {
    return fetch(url.toString(), {
      method,
      headers: { ...baseHeaders, Authorization: authHeader },
    });
  }

  if (isStream) {
    // Bun's fetch requires duplex:'half' to accept a ReadableStream body.
    return fetch(url.toString(), {
      method,
      headers: { ...baseHeaders, Authorization: authHeader },
      body: body as ReadableStream<Uint8Array>,
      // @ts-expect-error — duplex is in the WHATWG fetch spec but not in lib.dom.d.ts yet
      duplex: 'half',
    });
  }

  const buf = body as Buffer;
  return fetch(url.toString(), {
    method,
    headers: { ...baseHeaders, Authorization: authHeader },
    body: new Blob([new Uint8Array(buf).buffer as ArrayBuffer]),
  });
}
