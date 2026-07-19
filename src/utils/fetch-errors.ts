/**
 * Query parameters whose values are credentials rather than data. Monitor URLs
 * routinely carry a token this way (`?api_key={{PROD_KEY}}`), and since env
 * secrets are interpolated into the URL before the probe runs, the resolved
 * value would otherwise reach error messages, logs and alert payloads.
 *
 * Stored without separators; `isSensitiveParam` normalises before lookup so
 * `api_key`, `api-key` and `APIKey` all match the one entry.
 */
const SENSITIVE_PARAMS = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'token',
  'auth',
  'authorization',
  'secret',
  'clientsecret',
  'password',
  'passwd',
  'pwd',
  'sessionid',
  'session',
  'signature',
  'sig',
  'key',
]);

const REDACTED = 'REDACTED';

function isSensitiveParam(name: string): boolean {
  return SENSITIVE_PARAMS.has(name.toLowerCase().replaceAll(/[-_]/g, ''));
}

/**
 * Strip credentials from a URL so they don't leak into error messages, logs, or
 * alert payloads (Slack/webhook/email). Removes both basic-auth userinfo
 * (`user:pass@`) and the values of secret-bearing query parameters, leaving
 * ordinary query data intact so messages stay useful for debugging.
 * Falls back to regex strips if the URL won't parse.
 *
 * The result is for display only — never fetch the returned string.
 */
export function redactUrlCredentials(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    // Collect first: mutating searchParams while iterating it is undefined.
    // Only the matching params are touched, so a URL with no secrets
    // serialises exactly as it does today.
    const secretNames = [...u.searchParams.keys()].filter(isSensitiveParam);
    for (const name of secretNames) u.searchParams.set(name, REDACTED);
    return u.toString();
  } catch {
    // Not a parseable URL — apply the same two rules textually.
    return raw
      .replaceAll(/(\/\/)[^/@\s]*@/g, '$1')
      .replaceAll(/([?&])([^=&\s]+)=([^&\s]*)/g, (match, sep: string, name: string) =>
        isSensitiveParam(name) ? `${sep}${name}=${REDACTED}` : match,
      );
  }
}

/**
 * Map a thrown fetch error to a human-readable message.
 * Extracted from the duplicate ladders previously in url-monitor /
 * api-check processors. The URL is credential-redacted before it goes into
 * any message (these strings reach logs and alert channels).
 */
export function classifyFetchError(err: unknown, url: string, timeoutMs: number): string {
  if (!(err instanceof Error)) return 'Unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return `Request timed out after ${timeoutMs}ms`;
  }
  const safeUrl = redactUrlCredentials(url);

  // undici often embeds the full request URL inside the error text itself, so
  // redacting the `url` argument is not enough for the passthrough branches
  // below. We know the exact string to remove, so this is an exact swap rather
  // than a guess at what a secret looks like.
  const scrub = (text: string): string =>
    url && text.includes(url) ? text.split(url).join(safeUrl) : text;

  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause) {
    if (cause.code === 'ENOTFOUND') return `DNS resolution failed: Host not found (${safeUrl})`;
    if (cause.code === 'ECONNREFUSED')
      return `Connection refused: Target machine actively refused it (${safeUrl})`;
    if (cause.code === 'ETIMEDOUT') return `Connection timed out (${safeUrl})`;
    if (cause.message) return `Network error: ${scrub(cause.message)}`;
  }
  return scrub(err.message ?? 'Unknown error');
}
