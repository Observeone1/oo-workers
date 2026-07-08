/**
 * Strip userinfo (basic-auth `user:pass@`) from a URL so credentials embedded
 * in a monitor URL don't leak into error messages, logs, or alert payloads
 * (Slack/webhook/email). Falls back to a regex strip if the URL won't parse.
 */
export function redactUrlCredentials(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    // Not a parseable URL — strip any `//user:pass@` segment defensively.
    return raw.replace(/(\/\/)[^/@\s]*@/, '$1');
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
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause) {
    if (cause.code === 'ENOTFOUND') return `DNS resolution failed: Host not found (${safeUrl})`;
    if (cause.code === 'ECONNREFUSED')
      return `Connection refused: Target machine actively refused it (${safeUrl})`;
    if (cause.code === 'ETIMEDOUT') return `Connection timed out (${safeUrl})`;
    if (cause.message) return `Network error: ${cause.message}`;
  }
  return err.message ?? 'Unknown error';
}
