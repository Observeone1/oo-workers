-- 0002_scheduler.sql
-- Add scheduler columns: monitors can now be on a schedule (interval_seconds)
-- and toggled on/off (enabled) without deletion.

ALTER TABLE url_monitors
  ADD COLUMN interval_seconds INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE api_checks
  ADD COLUMN interval_seconds INTEGER NOT NULL DEFAULT 60,
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE qa_projects
  ADD COLUMN interval_seconds INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Indexes for the scheduler's "what's due?" query
CREATE INDEX idx_url_monitors_enabled ON url_monitors(enabled) WHERE enabled = TRUE;
CREATE INDEX idx_api_checks_enabled ON api_checks(enabled) WHERE enabled = TRUE;
CREATE INDEX idx_qa_projects_enabled ON qa_projects(enabled) WHERE enabled = TRUE;
