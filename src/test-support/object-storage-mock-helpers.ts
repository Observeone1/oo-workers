/**
 * Shared mock for the object-storage network boundary.
 *
 * Instead of mocking the whole object-storage.ts module (which poisons
 * object-storage.unit.spec.ts in parallel runs), we stub the lowest seam:
 * signedFetchRaw in object-storage-signing.ts. The real object-storage.ts
 * stays in play, so specs exercise URL building, config parsing, error
 * handling and the pure key helpers.
 */

import { mock } from 'bun:test';
import {
  __resetSignedFetchRawImpl,
  __setSignedFetchRawImpl,
} from '../services/object-storage-signing.ts';

export const signedFetchRawMock = mock(
  async (
    _method: 'GET' | 'PUT' | 'HEAD' | 'DELETE',
    _url: URL,
    _body: Buffer | ReadableStream<Uint8Array> | null,
    _accessKey: string,
    _secretKey: string,
    _region: string,
    _extraHeaders: Record<string, string> = {},
  ): Promise<Response> => new Response('OK', { status: 200 }),
);

/** Wire signedFetchRaw to the shared mock and reset it to a 200 OK default. */
export function mockObjectStorageSigning(): void {
  signedFetchRawMock.mockReset();
  signedFetchRawMock.mockResolvedValue(new Response('OK', { status: 200 }));
  __setSignedFetchRawImpl(
    signedFetchRawMock as typeof import('../services/object-storage-signing.ts').signedFetchRaw,
  );
}

/** Restore the real signedFetchRaw implementation and reset the mock. */
export function resetObjectStorageSigningMock(): void {
  signedFetchRawMock.mockReset();
  signedFetchRawMock.mockResolvedValue(new Response('OK', { status: 200 }));
  __resetSignedFetchRawImpl();
}

const ENV_KEYS = [
  'OO_OBJECT_STORAGE_ENDPOINT',
  'OO_OBJECT_STORAGE_REGION',
  'OO_OBJECT_STORAGE_BUCKET',
  'OO_OBJECT_STORAGE_ACCESS_KEY',
  'OO_OBJECT_STORAGE_SECRET_KEY',
  'OO_OBJECT_STORAGE_FORCE_PATH_STYLE',
];

/** Clear every object-storage env var. */
export function clearObjectStorageEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/** Set a complete, deterministic object-storage configuration. */
export function setFullObjectStorageEnv(): void {
  process.env.OO_OBJECT_STORAGE_ENDPOINT = 'http://storage.test';
  process.env.OO_OBJECT_STORAGE_BUCKET = 'mybucket';
  process.env.OO_OBJECT_STORAGE_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  process.env.OO_OBJECT_STORAGE_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  delete process.env.OO_OBJECT_STORAGE_REGION;
  delete process.env.OO_OBJECT_STORAGE_FORCE_PATH_STYLE;
}
