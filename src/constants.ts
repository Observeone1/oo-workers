/**
 * Shared default values. Keep in sync with `.default(...)` literals in
 * `src/db/schema.ts` (Drizzle's `.default()` needs a literal, so the schema
 * can't import these directly).
 */
export const DEFAULTS = {
  URL_TIMEOUT_MS: 30_000,
  TCP_TIMEOUT_MS: 5_000,
  UDP_TIMEOUT_MS: 5_000,
  DB_TIMEOUT_MS: 5_000,
  API_TIMEOUT_MS: 5_000,
  API_TIMEOUT_IMPORT_DEFAULT_MS: 10_000,
  QA_INTERVAL_SECONDS: 300,
  QA_RUN_TIMEOUT_MS: 30_000,
  SCHEDULER_TICK_MS: 5_000,
  UI_POLL_MS: 5_000,
  RESPONSE_BODY_TRUNCATE_CHARS: 5_000,
  // Hard cap on bytes read from an API-check response body. The read is
  // bounded (and covered by the request timeout) so a huge or slow-drip
  // response can't exhaust the worker's memory. Generous vs the 5k stored
  // truncation so assertions still see plenty of body.
  RESPONSE_BODY_MAX_BYTES: 2_000_000,
  // Hard cap on list-endpoint responses (incidents, status pages, API
  // keys). Listings used to return ALL rows unbounded — a long-lived
  // status page accumulating incidents would eventually OOM the worker.
  // 500 is generous for normal operator use; operators wanting more
  // should request pagination as a feature.
  LIST_DEFAULT_LIMIT: 500,
} as const;
