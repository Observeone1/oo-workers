/**
 * AWS Signature V4 primitives + low-level signed fetch.
 * Used exclusively by object-storage.ts — not a general-purpose module.
 */

import { createHash, createHmac } from 'node:crypto';

export function hex(buf: Buffer): string {
  return buf.toString('hex');
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac('AWS4' + secret, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * Sign + execute any S3 request given a pre-built URL.
 * Callers that need query-string support (ListObjectsV2, bucket PUT)
 * build the URL themselves; signedFetch (key-based) does the same.
 */
export async function signedFetchRaw(
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
  url: URL,
  body: Buffer | null,
  accessKey: string,
  secretKey: string,
  region: string,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadBuf = body ?? Buffer.alloc(0);
  const payloadHash = sha256Hex(payloadBuf);

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

  const qs = url.search ? url.search.slice(1) : '';
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

  const fetchBody =
    method === 'PUT' && body ? new Blob([new Uint8Array(body).buffer as ArrayBuffer]) : undefined;

  return fetch(url.toString(), {
    method,
    headers: { ...baseHeaders, Authorization: authHeader },
    body: fetchBody,
  });
}
