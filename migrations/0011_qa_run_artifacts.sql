-- 0011_qa_run_artifacts.sql
-- Phase 6.5 — capture Playwright artifacts (trace.zip + screenshots) on
-- failed QA monitor runs so operators can debug from the dashboard
-- instead of re-running locally.
--
-- Adds:
--   qa_test_executions.trace_url       — object-storage key for the
--     Playwright trace.zip (opens with `npx playwright show-trace`).
--     NULL when the run passed or storage was unavailable.
--   qa_test_executions.screenshot_urls — jsonb array of object-storage
--     keys for per-failure screenshots. NULL or '[]' when the run
--     passed or capture was disabled.
--
-- Both fields are populated by the qa-project processor immediately
-- after the Playwright run. Storage cleanup goes through the same
-- monitor-delete + boot-time sweep paths added in v1.1.1, just with
-- the `runs/` prefix included alongside script keys.

ALTER TABLE qa_test_executions
  ADD COLUMN trace_url VARCHAR(512),
  ADD COLUMN screenshot_urls JSONB;
