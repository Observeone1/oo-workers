-- QA region-alerting redesign. A "browser check" (QA project) run is many
-- per-test executions. The master path aggregates them synchronously and
-- alerts; the region-dispatched path reported each test result separately
-- with NO run-level aggregation, so region-bound QA monitors never fired
-- outage/recovery alerts. And the transition detector keyed off projectId
-- only, mis-blending regions the moment fan-out was used.
--
-- This introduces an explicit run row (per project + region) so a run can be
-- grouped, completion-detected by count, alerted exactly once (alerted_at),
-- and compared against the previous run for the SAME region.

CREATE TABLE qa_runs (
  id             SERIAL PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES qa_projects(id) ON DELETE CASCADE,
  -- NULL = master-run (no region). Non-null = region-dispatched run.
  region_id      INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expected_tests INTEGER NOT NULL,
  -- Aggregate run outcome, set once all expected tests complete.
  outcome        VARCHAR(20),
  -- Idempotency guard: the row that flips this from NULL wins the
  -- "last two results complete concurrently" race and fires the alert.
  alerted_at     TIMESTAMPTZ
);

CREATE INDEX idx_qa_runs_project_region_started
  ON qa_runs (project_id, region_id, started_at DESC);

-- Tie each test execution to its run. Nullable so pre-existing rows (which
-- have no run) are valid; new rows always get one.
ALTER TABLE qa_test_executions
  ADD COLUMN run_id INTEGER REFERENCES qa_runs(id) ON DELETE CASCADE;

CREATE INDEX idx_qa_test_executions_run_id ON qa_test_executions (run_id);
