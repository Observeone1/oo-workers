/**
 * Shared default values. Keep in sync with `.default(...)` literals in
 * `src/db/schema.ts` (Drizzle's `.default()` needs a literal, so the schema
 * can't import these directly).
 */
export const DEFAULTS = {
  URL_TIMEOUT_MS: 30_000,
  TCP_TIMEOUT_MS: 5_000,
  API_TIMEOUT_MS: 5_000,
  API_TIMEOUT_IMPORT_DEFAULT_MS: 10_000,
  QA_INTERVAL_SECONDS: 300,
  QA_RUN_TIMEOUT_MS: 30_000,
  SCHEDULER_TICK_MS: 5_000,
  UI_POLL_MS: 5_000,
  RESPONSE_BODY_TRUNCATE_CHARS: 5_000,
} as const;
