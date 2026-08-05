/**
 * Object-storage client contract — configuration parsing, URL construction,
 * all S3 operations, and the pure key helpers. External I/O is stubbed at the
 * signing boundary so no real bucket is needed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  mockObjectStorageSigning,
  resetObjectStorageSigningMock,
  signedFetchRawMock,
} from '../test-support/object-storage-mock-helpers.ts';

mockObjectStorageSigning();

const loggerInfo = mock((_msg: string) => {});
const loggerWarn = mock((_msg: string) => {});
const loggerError = mock((_msg: string) => {});
mock.module('../utils/logger.ts', () => ({
  logger: { info: loggerInfo, warn: loggerWarn, error: loggerError },
}));

interface StorageModule {
  isStorageConfigured(): boolean;
  putObject(key: string, body: string | Buffer, contentType?: string): Promise<string>;
  putObjectStream(
    key: string,
    body: ReadableStream<Uint8Array>,
    contentType: string,
    contentLength: number,
  ): Promise<string>;
  getObject(key: string): Promise<string>;
  getObjectResponse(key: string): Promise<Response>;
  ensureBucket(): Promise<void>;
  moveObject(oldKey: string, newKey: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  listObjects(prefix: string): Promise<string[]>;
  listObjectsWithSize(prefix: string): Promise<{ key: string; size: number }[]>;
  qaScriptKey(projectId: number, projectName: string, testId: number, testName: string): string;
  qaRunArtifactKey(
    projectId: number,
    projectName: string,
    executionId: number,
    filename: string,
  ): string;
  isLegacyQaScriptKey(key: string): boolean;
  resetObjectStorageConfigCache(): void;
}

const os = (await import('./object-storage.ts')) as unknown as StorageModule;

const ENV_KEYS = [
  'OO_OBJECT_STORAGE_ENDPOINT',
  'OO_OBJECT_STORAGE_REGION',
  'OO_OBJECT_STORAGE_BUCKET',
  'OO_OBJECT_STORAGE_ACCESS_KEY',
  'OO_OBJECT_STORAGE_SECRET_KEY',
  'OO_OBJECT_STORAGE_FORCE_PATH_STYLE',
];

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

beforeEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  os.resetObjectStorageConfigCache();
  mockObjectStorageSigning();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
  loggerError.mockClear();
});

function clearStorageEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function setFullStorageEnv() {
  process.env.OO_OBJECT_STORAGE_ENDPOINT = 'http://storage.test';
  process.env.OO_OBJECT_STORAGE_BUCKET = 'mybucket';
  process.env.OO_OBJECT_STORAGE_ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';
  process.env.OO_OBJECT_STORAGE_SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  delete process.env.OO_OBJECT_STORAGE_REGION;
  delete process.env.OO_OBJECT_STORAGE_FORCE_PATH_STYLE;
}

function lastSignedCall() {
  const calls = signedFetchRawMock.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1] as [
    'GET' | 'PUT' | 'HEAD' | 'DELETE',
    URL,
    Buffer | ReadableStream<Uint8Array> | null,
    string,
    string,
    string,
    Record<string, string>,
  ];
}

describe('configuration', () => {
  test('isStorageConfigured returns false when required env is missing', async () => {
    clearStorageEnv();

    expect(os.isStorageConfigured()).toBe(false);
  });

  test('isStorageConfigured returns true when env is complete', async () => {
    setFullStorageEnv();

    expect(os.isStorageConfigured()).toBe(true);
  });

  test('config is cached and not re-read on subsequent calls', async () => {
    setFullStorageEnv();
    expect(os.isStorageConfigured()).toBe(true);

    process.env.OO_OBJECT_STORAGE_BUCKET = 'tampered';
    expect(os.isStorageConfigured()).toBe(true);
    expect(signedFetchRawMock).not.toHaveBeenCalled();
  });

  test('missing config disables storage and caches null', async () => {
    clearStorageEnv();
    expect(os.isStorageConfigured()).toBe(false);

    setFullStorageEnv();
    expect(os.isStorageConfigured()).toBe(false);
  });

  test('strips trailing slashes from the endpoint', async () => {
    process.env.OO_OBJECT_STORAGE_ENDPOINT = 'http://storage.test///';
    process.env.OO_OBJECT_STORAGE_BUCKET = 'mybucket';
    process.env.OO_OBJECT_STORAGE_ACCESS_KEY = 'AK';
    process.env.OO_OBJECT_STORAGE_SECRET_KEY = 'SK';

    await os.putObject('k', 'body');

    const [, url] = lastSignedCall();
    expect(url.toString()).toStartWith('http://storage.test/');
    expect(url.toString()).not.toContain('storage.test//');
  });

  test('uses default region and path-style when omitted', async () => {
    setFullStorageEnv();

    await os.putObject('k', 'body');

    const [, , , accessKey, secretKey, region] = lastSignedCall();
    expect(accessKey).toBe('AKIAIOSFODNN7EXAMPLE');
    expect(secretKey).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(region).toBe('us-east-1');
    const [, url] = lastSignedCall();
    expect(url.hostname).toBe('storage.test');
    expect(url.pathname).toStartWith('/mybucket/');
  });
});

describe('URL construction', () => {
  test('builds path-style URLs by default', async () => {
    setFullStorageEnv();

    await os.putObject('path/to/object', 'body');

    const [, url] = lastSignedCall();
    expect(url.hostname).toBe('storage.test');
    expect(url.pathname).toBe('/mybucket/path/to/object');
  });

  test('builds virtual-hosted URLs when path style is disabled', async () => {
    setFullStorageEnv();
    process.env.OO_OBJECT_STORAGE_FORCE_PATH_STYLE = '0';

    await os.putObject('path/to/object', 'body');

    const [, url] = lastSignedCall();
    expect(url.hostname).toBe('mybucket.storage.test');
    expect(url.pathname).toBe('/path/to/object');
  });

  test('encodes reserved and special characters in keys', async () => {
    setFullStorageEnv();

    await os.putObject("foo/bar(baz)*qux'!", 'body');

    const [, url] = lastSignedCall();
    expect(url.pathname).toContain('%28');
    expect(url.pathname).toContain('%29');
    expect(url.pathname).toContain('%2A');
    expect(url.pathname).toContain('%21');
    expect(url.pathname).toContain('%27');
  });
});

describe('putObject', () => {
  test('writes a string body and returns the key', async () => {
    setFullStorageEnv();

    const result = await os.putObject('my-key', 'hello');

    expect(result).toBe('my-key');
    const [method, , body, , , , extra] = lastSignedCall();
    expect(method).toBe('PUT');
    expect(body).toBeInstanceOf(Buffer);
    expect((body as Buffer).toString()).toBe('hello');
    expect(extra['content-type']).toBe('application/octet-stream');
    expect(extra['content-length']).toBe('5');
  });

  test('writes a Buffer body with an explicit content type', async () => {
    setFullStorageEnv();

    await os.putObject('my-key', Buffer.from('binary'), 'image/png');

    const [, , body, , , , extra] = lastSignedCall();
    expect(body).toBeInstanceOf(Buffer);
    expect(extra['content-type']).toBe('image/png');
    expect(extra['content-length']).toBe('6');
  });

  test('throws ObjectStorageError on non-ok response', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('storage outage', { status: 503 }));

    const err = await os.putObject('my-key', 'body').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('PUT my-key failed: HTTP 503 storage outage');
    expect((err as { status?: number }).status).toBe(503);
  });

  test('tolerates a failing response body read', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('net')),
    } as unknown as Response);

    const err = await os.putObject('my-key', 'body').catch((e: unknown) => e);

    expect((err as Error).message).toContain('PUT my-key failed: HTTP 500 ');
  });
});

describe('putObjectStream', () => {
  test('writes a ReadableStream with the given headers', async () => {
    setFullStorageEnv();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    const result = await os.putObjectStream('stream-key', stream, 'application/zip', 12345);

    expect(result).toBe('stream-key');
    const [method, , body, , , , extra] = lastSignedCall();
    expect(method).toBe('PUT');
    expect(body).toBe(stream);
    expect(extra['content-type']).toBe('application/zip');
    expect(extra['content-length']).toBe('12345');
  });

  test('throws ObjectStorageError on failure', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('denied', { status: 403 }));
    const stream = new ReadableStream<Uint8Array>({ start: (c) => c.close() });

    const err = await os
      .putObjectStream('stream-key', stream, 'text/plain', 0)
      .catch((e: unknown) => e);

    expect((err as Error).message).toContain('PUT stream-key (stream) failed: HTTP 403 denied');
  });
});

describe('getObject', () => {
  test('returns the response text on success', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('object contents'));

    const result = await os.getObject('my-key');

    expect(result).toBe('object contents');
    const [method, , body] = lastSignedCall();
    expect(method).toBe('GET');
    expect(body).toBeNull();
  });

  test('throws ObjectStorageError on failure', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    const err = await os.getObject('my-key').catch((e: unknown) => e);

    expect((err as Error).message).toContain('GET my-key failed: HTTP 404 not found');
  });
});

describe('getObjectResponse', () => {
  test('returns the raw Response on success', async () => {
    setFullStorageEnv();
    const response = new Response('binary', { headers: { 'content-type': 'image/png' } });
    signedFetchRawMock.mockResolvedValueOnce(response);

    const result = await os.getObjectResponse('my-key');

    expect(result).toBe(response);
  });

  test('throws ObjectStorageError on failure', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('error', { status: 500 }));

    const err = await os.getObjectResponse('my-key').catch((e: unknown) => e);

    expect((err as Error).message).toContain('GET my-key failed: HTTP 500 error');
  });
});

describe('ensureBucket', () => {
  test('treats HTTP 200 as ready', async () => {
    setFullStorageEnv();

    await os.ensureBucket();

    const [method, url] = lastSignedCall();
    expect(method).toBe('PUT');
    expect(url.pathname).toBe('/mybucket');
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining("bucket 'mybucket' ready"));
  });

  test('treats HTTP 409 as ready', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('', { status: 409 }));

    await os.ensureBucket();

    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining("bucket 'mybucket' ready"));
  });

  test('treats BucketAlreadyOwnedByYou error body as already exists', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(
      new Response('<Error><Code>BucketAlreadyOwnedByYou</Code></Error>', { status: 403 }),
    );

    await os.ensureBucket();

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("bucket 'mybucket' already exists"),
    );
  });

  test('treats BucketAlreadyExists error body as already exists', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(
      new Response('<Error><Code>BucketAlreadyExists</Code></Error>', { status: 403 }),
    );

    await os.ensureBucket();

    expect(loggerInfo).toHaveBeenCalledWith(
      expect.stringContaining("bucket 'mybucket' already exists"),
    );
  });

  test('throws when bucket creation fails', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('bad request', { status: 400 }));

    const err = await os.ensureBucket().catch((e: unknown) => e);

    expect((err as Error).message).toContain(
      "ensureBucket('mybucket') failed: HTTP 400 bad request",
    );
  });
});

describe('moveObject', () => {
  test('is a no-op when source and destination are the same', async () => {
    setFullStorageEnv();

    await os.moveObject('same', 'same');

    expect(signedFetchRawMock).not.toHaveBeenCalled();
  });

  test('GETs, PUTs and DELETEs to move an object', async () => {
    setFullStorageEnv();

    await os.moveObject('old-key', 'new-key');

    expect(signedFetchRawMock).toHaveBeenCalledTimes(3);
    expect(signedFetchRawMock.mock.calls[0][0]).toBe('GET');
    expect(signedFetchRawMock.mock.calls[1][0]).toBe('PUT');
    expect(signedFetchRawMock.mock.calls[2][0]).toBe('DELETE');
  });
});

describe('deleteObject', () => {
  test('returns cleanly on success', async () => {
    setFullStorageEnv();

    await os.deleteObject('my-key');

    const [method, url] = lastSignedCall();
    expect(method).toBe('DELETE');
    expect(url.pathname).toContain('my-key');
  });

  test('ignores 404 responses', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

    await expect(os.deleteObject('missing')).resolves.toBeUndefined();
  });

  test('throws on other failures', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('denied', { status: 403 }));

    const err = await os.deleteObject('my-key').catch((e: unknown) => e);

    expect((err as Error).message).toContain('DELETE my-key failed: HTTP 403 denied');
  });
});

describe('listObjects', () => {
  test('pages through ListObjectsV2 results and extracts keys', async () => {
    setFullStorageEnv();
    let calls = 0;
    signedFetchRawMock.mockImplementation(async () => {
      calls++;
      if (calls === 1) {
        return new Response(
          '<Key>a</Key><Key>b</Key><NextContinuationToken>tok2</NextContinuationToken>',
        );
      }
      return new Response('<Key>c</Key>');
    });

    const keys = await os.listObjects('qa-projects/');

    expect(keys).toEqual(['a', 'b', 'c']);
    expect(signedFetchRawMock).toHaveBeenCalledTimes(2);
    const [, firstUrl] = signedFetchRawMock.mock.calls[0];
    expect((firstUrl as URL).searchParams.get('list-type')).toBe('2');
    expect((firstUrl as URL).searchParams.get('prefix')).toBe('qa-projects/');
    expect((firstUrl as URL).searchParams.has('continuation-token')).toBe(false);
    const [, secondUrl] = signedFetchRawMock.mock.calls[1];
    expect((secondUrl as URL).searchParams.get('continuation-token')).toBe('tok2');
  });

  test('throws ObjectStorageError on list failure', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('down', { status: 503 }));

    const err = await os.listObjects('prefix/').catch((e: unknown) => e);

    expect((err as Error).message).toContain('LIST prefix/ failed: HTTP 503 down');
  });
});

describe('listObjectsWithSize', () => {
  test('extracts key and size pairs from ListObjectsV2 XML', async () => {
    setFullStorageEnv();
    const xml = `
      <Contents><Key>a</Key><Size>10</Size></Contents>
      <Contents><Key>b</Key><LastModified>2024-01-01</LastModified><Size>20</Size></Contents>
    `;
    signedFetchRawMock.mockResolvedValueOnce(new Response(xml));

    const result = await os.listObjectsWithSize('qa-projects/');

    expect(result).toEqual([
      { key: 'a', size: 10 },
      { key: 'b', size: 20 },
    ]);
  });

  test('throws ObjectStorageError on list failure', async () => {
    setFullStorageEnv();
    signedFetchRawMock.mockResolvedValueOnce(new Response('down', { status: 503 }));

    const err = await os.listObjectsWithSize('prefix/').catch((e: unknown) => e);

    expect((err as Error).message).toContain('LIST prefix/ failed: HTTP 503 down');
  });
});

describe('key helpers', () => {
  test('qaScriptKey builds a namespaced path', () => {
    expect(os.qaScriptKey(7, 'My Project', 12, 'Login Test')).toBe(
      'qa-projects/7-my-project/12-login-test.spec.ts',
    );
  });

  test('qaRunArtifactKey builds a run-scoped path', () => {
    expect(os.qaRunArtifactKey(7, 'My Project', 99, 'trace.zip')).toBe(
      'qa-projects/7-my-project/runs/99/trace.zip',
    );
  });

  test('isLegacyQaScriptKey recognises the old prefix', () => {
    expect(os.isLegacyQaScriptKey('qa-scripts/42.spec.ts')).toBe(true);
    expect(os.isLegacyQaScriptKey('qa-projects/7/foo.spec.ts')).toBe(false);
  });

  test('slug normalises names for safe keys', () => {
    expect(os.qaScriptKey(1, 'Café Röyale!!', 1, 'Test (urgent)*')).toBe(
      'qa-projects/1-cafe-royale/1-test-urgent.spec.ts',
    );
  });

  test('slug caps length and falls back to untitled', () => {
    const long = 'a'.repeat(50);
    const key = os.qaScriptKey(1, long, 1, 'test');
    const slugPart = key.split('/')[1].split('-').slice(1).join('-');
    expect(slugPart.length).toBeLessThanOrEqual(40);

    const empty = os.qaScriptKey(1, '---', 1, '---');
    expect(empty).toBe('qa-projects/1-untitled/1-untitled.spec.ts');
  });
});

describe('unconfigured errors', () => {
  test('operations throw when storage is not configured', async () => {
    clearStorageEnv();
    os.resetObjectStorageConfigCache();

    const err = await os.putObject('k', 'b').catch((e: unknown) => e);
    expect((err as Error).message).toContain('object storage is not configured');
    expect((err as { status?: number }).status).toBe(500);
  });
});

afterAll(() => {
  resetObjectStorageSigningMock();
});
