-- 0001_init.sql
-- Initial schema for oo-workers (self-host).
-- Derived from internal Liquibase changelogs 0051 (api), 0059 (url), 0086 (qa).
-- Stripped: user_id/admin_id, team_id, is_team_*, is_hidden, company_* columns.
-- Added: qa_generated_tests.script TEXT replaces external-storage script_url.

-- ============================================================
-- URL monitoring
-- ============================================================

CREATE TABLE url_monitors (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  description       TEXT,
  url               TEXT NOT NULL,
  timeout_ms        INTEGER NOT NULL DEFAULT 30000,
  alert_on_failure  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE url_monitor_assertions (
  id              SERIAL PRIMARY KEY,
  url_monitor_id  INTEGER NOT NULL REFERENCES url_monitors(id) ON DELETE CASCADE,
  operator        VARCHAR(50) NOT NULL,
  status_code     INTEGER NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE url_monitor_executions (
  id                 SERIAL PRIMARY KEY,
  url_monitor_id     INTEGER NOT NULL REFERENCES url_monitors(id) ON DELETE CASCADE,
  status             VARCHAR(20) NOT NULL,
  status_code        INTEGER,
  response_time_ms   INTEGER,
  error_message      TEXT,
  assertion_results  JSONB,
  start_time         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time           TIMESTAMPTZ
);

CREATE INDEX idx_url_monitor_executions_monitor_id ON url_monitor_executions(url_monitor_id);
CREATE INDEX idx_url_monitor_executions_start_time ON url_monitor_executions(start_time);

-- ============================================================
-- API monitoring
-- ============================================================

CREATE TABLE api_checks (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  description  TEXT,
  url          TEXT NOT NULL,
  method       VARCHAR(10) NOT NULL DEFAULT 'GET',
  headers      JSONB DEFAULT '{}'::jsonb,
  body         TEXT,
  timeout_ms   INTEGER NOT NULL DEFAULT 5000,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_assertions (
  id            SERIAL PRIMARY KEY,
  api_check_id  INTEGER NOT NULL REFERENCES api_checks(id) ON DELETE CASCADE,
  type          VARCHAR(50) NOT NULL,
  operator      VARCHAR(50) NOT NULL,
  path          VARCHAR(255),
  value         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_executions (
  id                 SERIAL PRIMARY KEY,
  api_check_id       INTEGER NOT NULL REFERENCES api_checks(id) ON DELETE CASCADE,
  status             VARCHAR(20) NOT NULL,
  response_status    INTEGER,
  response_time_ms   INTEGER,
  response_body      TEXT,
  response_headers   JSONB,
  error_message      TEXT,
  assertion_results  JSONB,
  start_time         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time           TIMESTAMPTZ
);

CREATE INDEX idx_api_executions_check_id   ON api_executions(api_check_id);
CREATE INDEX idx_api_executions_start_time ON api_executions(start_time);

-- ============================================================
-- QA (Playwright) monitoring
-- ============================================================

CREATE TABLE qa_projects (
  id           SERIAL PRIMARY KEY,
  name         VARCHAR(255) NOT NULL,
  notes        TEXT,
  target_url   VARCHAR(1024) NOT NULL,
  credentials  JSONB,
  status       VARCHAR(50) DEFAULT 'pending',
  config       JSONB,
  last_run_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE qa_generated_tests (
  id           SERIAL PRIMARY KEY,
  project_id   INTEGER NOT NULL REFERENCES qa_projects(id) ON DELETE CASCADE,
  test_name    VARCHAR(255),
  test_type    VARCHAR(50),
  script       TEXT NOT NULL,
  description  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_qa_generated_tests_project_id ON qa_generated_tests(project_id);

CREATE TABLE qa_test_executions (
  id             SERIAL PRIMARY KEY,
  test_id        INTEGER NOT NULL REFERENCES qa_generated_tests(id) ON DELETE CASCADE,
  project_id     INTEGER NOT NULL REFERENCES qa_projects(id) ON DELETE CASCADE,
  status         VARCHAR(20) NOT NULL,
  error_message  TEXT,
  logs           TEXT,
  duration_ms    INTEGER,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX idx_qa_test_executions_test_id    ON qa_test_executions(test_id);
CREATE INDEX idx_qa_test_executions_project_id ON qa_test_executions(project_id);

-- ============================================================
-- updated_at auto-update trigger
-- ============================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_url_monitors_updated_at
  BEFORE UPDATE ON url_monitors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_api_checks_updated_at
  BEFORE UPDATE ON api_checks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_qa_projects_updated_at
  BEFORE UPDATE ON qa_projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
