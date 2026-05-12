/**
 * Map a thrown fetch error to a human-readable message.
 * Extracted from the duplicate ladders previously in url-monitor /
 * api-check processors.
 */
export function classifyFetchError(err: unknown, url: string, timeoutMs: number): string {
  if (!(err instanceof Error)) return 'Unknown error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return `Request timed out after ${timeoutMs}ms`;
  }
  const cause = (err as { cause?: { code?: string; message?: string } }).cause;
  if (cause) {
    if (cause.code === 'ENOTFOUND') return `DNS resolution failed: Host not found (${url})`;
    if (cause.code === 'ECONNREFUSED')
      return `Connection refused: Target machine actively refused it (${url})`;
    if (cause.code === 'ETIMEDOUT') return `Connection timed out (${url})`;
    if (cause.message) return `Network error: ${cause.message}`;
  }
  return err.message ?? 'Unknown error';
}
