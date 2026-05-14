/**
 * Hand-rolled S3-compatible object storage client.
 *
 * Talks AWS Signature V4 to any S3 API: the bundled RustFS default,
 * AWS S3, Cloudflare R2, Backblaze B2, on-prem MinIO/Ceph, etc. Three
 * operations only — putObject, getObject, plus ensureBucket
 * for first-boot setup. No list, no delete, no multipart in v1; QA
 * scripts are small (KB) and immutable after create.
 *
 * Why hand-roll instead of @aws-sdk/client-s3:
 *   - That SDK is ~6MB compiled, pulls 30+ transitive deps, and is built
 *     around a layered middleware system we don't need.
 *   - We send three header types + a body. Sig-V4 is ~150 LOC done
 *     directly. Bundle size and dep audit surface both stay small.
 *
 * Storage is configured via env (read once at import time):
 *   OO_OBJECT_STORAGE_ENABLED          — '1'/'true' to enable (default '1' when other vars set)
 *   OO_OBJECT_STORAGE_ENDPOINT         — http(s)://host[:port], no trailing slash
 *   OO_OBJECT_STORAGE_REGION           — defaults to 'us-east-1' (works for path-style)
 *   OO_OBJECT_STORAGE_BUCKET           — bucket name (must exist or be created)
 *   OO_OBJECT_STORAGE_ACCESS_KEY       — access key ID
 *   OO_OBJECT_STORAGE_SECRET_KEY       — secret access key
 *   OO_OBJECT_STORAGE_FORCE_PATH_STYLE — '1' to force path-style URLs (default '1' — works
 *                                        with RustFS and AWS; some R2 setups want '0')
 */

import { createHash, createHmac } from 'node:crypto';
import { logger } from '../utils/logger.ts';

interface Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  pathStyle: boolean;
}

let cached: Config | null = null;
let cachedDisabled = false;

function readConfig(): Config | null {
  if (cached) return cached;
  if (cachedDisabled) return null;
  const endpoint = process.env.OO_OBJECT_STORAGE_ENDPOINT?.replace(/\/+$/, '');
  const bucket = process.env.OO_OBJECT_STORAGE_BUCKET;
  const accessKey = process.env.OO_OBJECT_STORAGE_ACCESS_KEY;
  const secretKey = process.env.OO_OBJECT_STORAGE_SECRET_KEY;
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    cachedDisabled = true;
    return null;
  }
  cached = {
    endpoint,
    region: process.env.OO_OBJECT_STORAGE_REGION ?? 'us-east-1',
    bucket,
    accessKey,
    secretKey,
    pathStyle: process.env.OO_OBJECT_STORAGE_FORCE_PATH_STYLE !== '0',
  };
  return cached;
}

/** True when env is wired for object storage. Callers should branch on this. */
export function isStorageConfigured(): boolean {
  return readConfig() !== null;
}

// ---------------- AWS Signature V4 ----------------

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

function buildUrl(cfg: Config, key: string): URL {
  const ep = new URL(cfg.endpoint);
  if (cfg.pathStyle) {
    ep.pathname = `/${cfg.bucket}/${encodeKey(key)}`;
  } else {
    ep.hostname = `${cfg.bucket}.${ep.hostname}`;
    ep.pathname = `/${encodeKey(key)}`;
  }
  return ep;
}

function encodeKey(key: string): string {
  // RFC 3986 unreserved + '/' (S3 keys preserve slashes). Mirrors the AWS
  // spec's "encodeURI but encode '+' and other reserved chars".
  return key
    .split('/')
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/');
}

async function signedFetch(
  cfg: Config,
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
  key: string,
  body: Buffer | null,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const url = buildUrl(cfg, key);
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

  const canonicalRequest = [
    method,
    url.pathname,
    '', // query
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kSigning = signingKey(cfg.secretKey, dateStamp, cfg.region, 's3');
  const signature = hex(hmac(kSigning, stringToSign));

  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  // Bun's fetch accepts a Blob / ArrayBuffer cleanly; coerce Buffer through
  // its underlying bytes to keep TS happy across all overloads.
  const fetchBody =
    method === 'PUT' && body ? new Blob([new Uint8Array(body).buffer as ArrayBuffer]) : undefined;
  return fetch(url.toString(), {
    method,
    headers: { ...baseHeaders, Authorization: authHeader },
    body: fetchBody,
  });
}

// ---------------- Public API ----------------

class ObjectStorageError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function requireConfig(): Config {
  const cfg = readConfig();
  if (!cfg) {
    throw new ObjectStorageError('object storage is not configured (set OO_OBJECT_STORAGE_*)', 500);
  }
  return cfg;
}

export async function putObject(
  key: string,
  body: string | Buffer,
  contentType = 'application/octet-stream',
): Promise<string> {
  const cfg = requireConfig();
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const res = await signedFetch(cfg, 'PUT', key, buf, {
    'content-type': contentType,
    'content-length': String(buf.length),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ObjectStorageError(
      `PUT ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return key;
}

export async function getObject(key: string): Promise<string> {
  const cfg = requireConfig();
  const res = await signedFetch(cfg, 'GET', key, null);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ObjectStorageError(
      `GET ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return res.text();
}

/**
 * Fetch a raw object as a `Response` so callers can stream binary content
 * (trace.zip, screenshot PNG) without forcing it through string decoding.
 * Used by the artifact proxy endpoint to pipe bytes to the dashboard.
 */
export async function getObjectResponse(key: string): Promise<Response> {
  const cfg = requireConfig();
  const res = await signedFetch(cfg, 'GET', key, null);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ObjectStorageError(
      `GET ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
      res.status,
    );
  }
  return res;
}

/**
 * Idempotently create the configured bucket. Safe to call on every boot:
 * a 409 BucketAlreadyOwnedByYou (or 200 from re-create) is treated as success.
 * Some implementations return 409 on second create, others 200; both are OK.
 */
export async function ensureBucket(): Promise<void> {
  const cfg = requireConfig();
  // Issue a bucket-level PUT to the endpoint root + bucket name.
  const ep = new URL(cfg.endpoint);
  ep.pathname = `/${cfg.bucket}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex('');
  const headers: Record<string, string> = {
    host: ep.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const sorted = Object.keys(headers).sort();
  const canonicalHeaders = sorted.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sorted.join(';');
  const canonicalRequest = [
    'PUT',
    ep.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const kSigning = signingKey(cfg.secretKey, dateStamp, cfg.region, 's3');
  const signature = hex(hmac(kSigning, stringToSign));
  const authHeader =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const res = await fetch(ep.toString(), {
    method: 'PUT',
    headers: { ...headers, Authorization: authHeader },
  });
  if (res.status === 200 || res.status === 409) {
    logger.info(`object storage: bucket '${cfg.bucket}' ready (HTTP ${res.status})`);
    return;
  }
  // RustFS may return 200 with a BucketAlreadyOwnedByYou body — treat as ready.
  const text = await res.text().catch(() => '');
  if (text.includes('BucketAlreadyOwnedByYou') || text.includes('BucketAlreadyExists')) {
    logger.info(`object storage: bucket '${cfg.bucket}' already exists`);
    return;
  }
  throw new ObjectStorageError(
    `ensureBucket('${cfg.bucket}') failed: HTTP ${res.status} ${text.slice(0, 300)}`,
    res.status,
  );
}

/** A stable key for a QA test script. */
export function qaScriptKey(
  projectId: number,
  projectName: string,
  testId: number,
  testName: string,
): string {
  return `qa-projects/${projectId}-${slug(projectName)}/${testId}-${slug(testName)}.spec.ts`;
}

/**
 * Key for a run artifact (Playwright trace or screenshot) tied to a single
 * execution. Sits under the project's folder so the bucket layout stays
 * coherent and the boot-time orphan sweep finds it without extra prefixes.
 */
export function qaRunArtifactKey(
  projectId: number,
  projectName: string,
  executionId: number,
  filename: string,
): string {
  return `qa-projects/${projectId}-${slug(projectName)}/runs/${executionId}/${filename}`;
}

/** True if a key looks like the legacy `qa-scripts/<id>.spec.ts` layout. */
export function isLegacyQaScriptKey(key: string): boolean {
  return key.startsWith('qa-scripts/');
}

/**
 * Slug helper for keys: lowercase ASCII, hyphen-separated, capped at 40
 * chars. Strips diacritics so non-ASCII project names still produce readable
 * keys. Falls back to "untitled" so we never emit an empty path segment.
 */
function slug(input: string): string {
  const normalized = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const capped = normalized.slice(0, 40).replace(/-+$/g, '');
  return capped || 'untitled';
}

/**
 * Copy an object to a new key, idempotently. S3 doesn't have an atomic move —
 * we GET, PUT to the new key, then DELETE the old. Boot-time storage layout
 * migration calls this; not used on the hot path.
 */
export async function moveObject(oldKey: string, newKey: string): Promise<void> {
  if (oldKey === newKey) return;
  const body = await getObject(oldKey);
  await putObject(newKey, body, 'text/typescript');
  await deleteObject(oldKey);
}

/** Best-effort DELETE — used by the boot-time migration and the QA delete path. */
export async function deleteObject(key: string): Promise<void> {
  const cfg = requireConfig();
  const res = await signedFetch(cfg, 'DELETE', key, null);
  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    throw new ObjectStorageError(
      `DELETE ${key} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
      res.status,
    );
  }
}

/**
 * List all object keys under the given prefix. Pages through ListObjectsV2
 * until the bucket is exhausted. Used by the boot-time orphan sweep.
 */
export async function listObjects(prefix: string): Promise<string[]> {
  const cfg = requireConfig();
  const out: string[] = [];
  let continuationToken: string | undefined;
  do {
    const url = new URL(cfg.endpoint);
    url.pathname = `/${cfg.bucket}`;
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    if (continuationToken) url.searchParams.set('continuation-token', continuationToken);

    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex('');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const sorted = Object.keys(headers).sort();
    const canonicalHeaders = sorted.map((k) => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sorted.join(';');
    const qs = [...url.searchParams.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const canonicalRequest = [
      'GET',
      url.pathname,
      qs,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const kSigning = signingKey(cfg.secretKey, dateStamp, cfg.region, 's3');
    const signature = hex(hmac(kSigning, stringToSign));
    const authHeader =
      `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const res = await fetch(url.toString(), { headers: { ...headers, Authorization: authHeader } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ObjectStorageError(
        `LIST ${prefix} failed: HTTP ${res.status} ${text.slice(0, 200)}`,
        res.status,
      );
    }
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) out.push(m[1]);
    const nextMatch = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    continuationToken = nextMatch?.[1];
  } while (continuationToken);
  return out;
}
