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
  // How long a qa_runs row may sit without a verdict before the scheduler
  // declares it abandoned, marks it FAILED and lets the normal transition
  // alert fire. Generous vs QA_INTERVAL_SECONDS (300s) and the per-test
  // QA_RUN_TIMEOUT_MS (30s) so a slow-but-alive run is never mistaken for a
  // dead one. Override with QA_RUN_ABANDONED_MS.
  QA_RUN_ABANDONED_MS: 900_000,
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

/**
 * The `qa_runs.outcome` values that are a **verdict about the monitored
 * target** — the only ones alerting is allowed to reason about.
 *
 * `QA_RUN_ABANDONED` is deliberately not one of them. It records that our own
 * execution machinery (worker, region agent, Playwright launch) failed to
 * produce a result, which says nothing about whether the customer's app is
 * healthy. Such a run is finalized so it stops being NULL-invisible, but it is
 * excluded from the previous-run lookup so it neither fires an alert nor
 * suppresses the next real one. See docs/alerts.md.
 */
export const QA_RUN_VERDICTS = ['SUCCESS', 'FAILED'] as const;
export const QA_RUN_ABANDONED = 'ABANDONED';

/**
 * `qa_test_executions.status` for a test stranded by an abandoned run.
 * Chosen to sit OUTSIDE both the up set (`SUCCESS`/`passed`) and the down set
 * (`FAILED`/`failed`/`ERROR`/`error`) that status pages and uptime math key
 * off, so our own failure never paints a monitor red or dents its uptime —
 * exactly as the `running` these rows previously kept forever did not.
 */
export const QA_EXEC_ABANDONED = 'abandoned';
