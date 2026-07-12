import { describe, test, expect } from 'bun:test';
import { classifyFetchError, redactUrlCredentials } from './fetch-errors.ts';

describe('redactUrlCredentials', () => {
  test('strips basic-auth user:pass from a URL', () => {
    expect(redactUrlCredentials('https://user:s3cret@api.example.com/path')).toBe(
      'https://api.example.com/path',
    );
  });

  test('strips a username-only credential', () => {
    expect(redactUrlCredentials('https://token@api.example.com/')).toBe('https://api.example.com/');
  });

  test('leaves a credential-free URL unchanged', () => {
    expect(redactUrlCredentials('https://api.example.com/path?q=1')).toBe(
      'https://api.example.com/path?q=1',
    );
  });

  test('falls back to a regex strip when the URL will not parse', () => {
    // Not a valid absolute URL, but still carries userinfo — must be redacted.
    expect(redactUrlCredentials('ftp+weird://user:pass@host/x')).not.toContain('pass');
  });
});

describe('classifyFetchError redacts the URL', () => {
  const credUrl = 'https://user:s3cret@api.example.com/path';

  test('ENOTFOUND message does not leak credentials', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const msg = classifyFetchError(err, credUrl, 5000);
    expect(msg).toContain('api.example.com');
    expect(msg).not.toContain('s3cret');
  });

  test('ECONNREFUSED message does not leak credentials', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    expect(classifyFetchError(err, credUrl, 5000)).not.toContain('s3cret');
  });

  test('timeout message is unchanged (no URL in it)', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyFetchError(err, credUrl, 5000)).toBe('Request timed out after 5000ms');
  });

  test('TimeoutError name is also treated as a timeout', () => {
    const err = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect(classifyFetchError(err, credUrl, 3000)).toBe('Request timed out after 3000ms');
  });

  test('ETIMEDOUT cause message does not leak credentials', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } });
    const msg = classifyFetchError(err, credUrl, 5000);
    expect(msg).toBe('Connection timed out (https://api.example.com/path)');
  });

  test('cause with an unrecognised code falls back to cause.message', () => {
    const err = Object.assign(new Error('fetch failed'), {
      cause: { code: 'EAI_AGAIN', message: 'temporary DNS failure' },
    });
    expect(classifyFetchError(err, credUrl, 5000)).toBe('Network error: temporary DNS failure');
  });

  test('non-Error thrown values are reported as "Unknown error"', () => {
    expect(classifyFetchError('a plain string was thrown', credUrl, 5000)).toBe('Unknown error');
    expect(classifyFetchError(undefined, credUrl, 5000)).toBe('Unknown error');
    expect(classifyFetchError({ message: 'not an Error instance' }, credUrl, 5000)).toBe(
      'Unknown error',
    );
  });

  test('plain Error with no cause and no special name falls back to err.message', () => {
    const err = new Error('boom');
    expect(classifyFetchError(err, credUrl, 5000)).toBe('boom');
  });
});
