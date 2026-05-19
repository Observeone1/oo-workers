-- 0016_tls.sql
-- TLS certificate-expiry monitor. Does the TLS handshake and inspects the
-- peer certificate; FAILS when it expires within `warn_days`. Mirrors the
-- db monitor's shape. rejectUnauthorized is off at probe time (self-signed
-- / internal-CA endpoints still get expiry-monitored — same self-signed
-- posture as the db-tls work). Chain/hostname validity + expect_cn_regex
-- are a deliberate future follow-up, not built here.

CREATE TABLE tls_monitors (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  description       TEXT,
  host              VARCHAR(255) NOT NULL,
  port              INTEGER NOT NULL DEFAULT 443,
  servername        VARCHAR(255),
  warn_days         INTEGER NOT NULL DEFAULT 30,
  timeout_ms        INTEGER NOT NULL DEFAULT 5000,
  interval_seconds  INTEGER NOT NULL DEFAULT 60,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tls_executions (
  id              SERIAL PRIMARY KEY,
  tls_monitor_id  INTEGER NOT NULL REFERENCES tls_monitors(id) ON DELETE CASCADE,
  region_id       INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  status          VARCHAR(20) NOT NULL,
  latency_ms      INTEGER,
  days_remaining  INTEGER,
  valid_to        TIMESTAMPTZ,
  cert_summary    TEXT,
  error_message   TEXT,
  start_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time        TIMESTAMPTZ
);

CREATE INDEX idx_tls_executions_monitor_id ON tls_executions(tls_monitor_id);
CREATE INDEX idx_tls_executions_start_time ON tls_executions(start_time);
CREATE INDEX idx_tls_executions_region_id ON tls_executions(region_id);
CREATE INDEX idx_tls_monitors_enabled ON tls_monitors(enabled) WHERE enabled = TRUE;

CREATE TRIGGER update_tls_monitors_updated_at
  BEFORE UPDATE ON tls_monitors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
