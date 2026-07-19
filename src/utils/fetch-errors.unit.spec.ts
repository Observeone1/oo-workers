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
});

// Regression: env secrets are interpolated into monitor URLs before the probe
// runs ({{PROD_API_KEY}} -> the real token), so a token in the query string is
// the common shape. Redacting only basic-auth userinfo left these exposed in
// error_message and in outbound alert payloads.
describe('redactUrlCredentials strips secret query parameters', () => {
  test('redacts an api_key value', () => {
    const out = redactUrlCredentials('https://api.example.com/health?api_key=s3cret');
    expect(out).not.toContain('s3cret');
    expect(out).toContain('api_key=REDACTED');
  });

  test.each([
    'token',
    'access_token',
    'refresh_token',
    'auth',
    'authorization',
    'secret',
    'client_secret',
    'password',
    'pwd',
    'signature',
    'sig',
    'key',
    'apikey',
    'api-key',
    'sessionId',
    'ACCESS_TOKEN',
  ])('redacts the %s parameter', (name) => {
    expect(redactUrlCredentials(`https://api.example.com/?${name}=s3cret`)).not.toContain('s3cret');
  });

  test('keeps non-secret query data intact alongside a redacted secret', () => {
    const out = redactUrlCredentials('https://api.example.com/?region=eu&token=s3cret&page=2');
    expect(out).toContain('region=eu');
    expect(out).toContain('page=2');
    expect(out).not.toContain('s3cret');
  });

  test('redacts both userinfo and a query secret in the same URL', () => {
    const out = redactUrlCredentials('https://user:pw0rd@api.example.com/?token=s3cret');
    expect(out).not.toContain('pw0rd');
    expect(out).not.toContain('s3cret');
    expect(out).toContain('api.example.com');
  });

  test('redacts a query secret even when the URL will not parse', () => {
    expect(redactUrlCredentials('not a url ?api_key=s3cret')).not.toContain('s3cret');
  });
});

describe('classifyFetchError does not leak query-string secrets', () => {
  const tokenUrl = 'https://api.example.com/health?api_key=s3cret';

  test('ENOTFOUND message redacts the token but keeps the host', () => {
    const err = Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const msg = classifyFetchError(err, tokenUrl, 5000);
    expect(msg).toContain('api.example.com');
    expect(msg).not.toContain('s3cret');
  });

  // undici embeds the request URL in the message text itself, so redacting the
  // `url` argument alone was not enough on these two passthrough branches.
  test('Network error passthrough scrubs a URL embedded in the cause message', () => {
    const err = Object.assign(new Error('fetch failed'), {
      cause: { message: `connect ECONNREFUSED for ${tokenUrl}` },
    });
    const msg = classifyFetchError(err, tokenUrl, 5000);
    expect(msg).not.toContain('s3cret');
    expect(msg).toContain('api_key=REDACTED');
  });

  test('final fallback scrubs a URL embedded in the error message', () => {
    const err = new Error(`request to ${tokenUrl} failed`);
    expect(classifyFetchError(err, tokenUrl, 5000)).not.toContain('s3cret');
  });

  test('an empty error message still yields an empty string (unchanged)', () => {
    // Pins the `?? 'Unknown error'` semantics: '' is not nullish, so it passes
    // through. Assigned rather than constructed so the empty string is not an
    // Error-constructor literal.
    const err = new Error('placeholder');
    err.message = '';
    expect(classifyFetchError(err, tokenUrl, 5000)).toBe('');
  });
});
