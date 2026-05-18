-- 0013_db.sql
-- Database protocol checks — credential-free liveness: open a socket and
-- confirm the server speaks the protocol (postgres / mysql / redis).
-- No credentials are stored (same posture as tcp/udp: "is it up?", not
-- "can I run authenticated queries?"). A future optional dsn/query column
-- can add authenticated-mode checks without breaking this.

CREATE TABLE db_monitors (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  description       TEXT,
  protocol          VARCHAR(16) NOT NULL CHECK (protocol IN ('postgres', 'mysql', 'redis')),
  host              VARCHAR(255) NOT NULL,
  port              INTEGER NOT NULL,
  timeout_ms        INTEGER NOT NULL DEFAULT 5000,
  interval_seconds  INTEGER NOT NULL DEFAULT 60,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE db_executions (
  id              SERIAL PRIMARY KEY,
  db_monitor_id   INTEGER NOT NULL REFERENCES db_monitors(id) ON DELETE CASCADE,
  region_id       INTEGER REFERENCES regions(id) ON DELETE SET NULL,
  status          VARCHAR(20) NOT NULL,
  latency_ms      INTEGER,
  error_message   TEXT,
  start_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time        TIMESTAMPTZ
);

CREATE INDEX idx_db_executions_monitor_id ON db_executions(db_monitor_id);
CREATE INDEX idx_db_executions_start_time ON db_executions(start_time);
CREATE INDEX idx_db_executions_region_id ON db_executions(region_id);
CREATE INDEX idx_db_monitors_enabled ON db_monitors(enabled) WHERE enabled = TRUE;

CREATE TRIGGER update_db_monitors_updated_at
  BEFORE UPDATE ON db_monitors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
