/**
 * Query parameters whose values are credentials rather than data. Monitor URLs
 * routinely carry a token this way (`?api_key={{PROD_KEY}}`), and since env
 * secrets are interpolated into the URL before the probe runs, the resolved
 * value would otherwise reach error messages, logs and alert channels.
 */
const SENSITIVE_PARAM =
  /^(api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|auth|authorization|secret|client[-_]?secret|password|passwd|pwd|session[-_]?id|session|signature|sig|key)$/i;

const REDACTED = 'REDACTED';

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
    // Snapshot the keys: mutating searchParams while iterating it is undefined.
    // Only touch the params that match, so a URL with no secrets serialises
    // exactly as it does today.
    for (const name of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(name)) u.searchParams.set(name, REDACTED);
    }
    return u.toString();
  } catch {
    // Not a parseable URL — strip defensively with the same two rules.
    return raw
      .replace(/(\/\/)[^/@\s]*@/, '$1')
      .replace(
        /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|auth[-_]?token|token|auth|authorization|secret|client[-_]?secret|password|passwd|pwd|session[-_]?id|session|signature|sig|key)=)[^&\s]*/gi,
        `$1${REDACTED}`,
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
