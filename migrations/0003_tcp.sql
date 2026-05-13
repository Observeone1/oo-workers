-- 0003_tcp.sql
-- TCP probes — checks a host:port is reachable and measures connect latency.

CREATE TABLE tcp_monitors (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  description       TEXT,
  host              VARCHAR(255) NOT NULL,
  port              INTEGER NOT NULL,
  timeout_ms        INTEGER NOT NULL DEFAULT 5000,
  interval_seconds  INTEGER NOT NULL DEFAULT 60,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tcp_executions (
  id              SERIAL PRIMARY KEY,
  tcp_monitor_id  INTEGER NOT NULL REFERENCES tcp_monitors(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL,
  latency_ms      INTEGER,
  error_message   TEXT,
  start_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time        TIMESTAMPTZ
);

CREATE INDEX idx_tcp_executions_monitor_id ON tcp_executions(tcp_monitor_id);
CREATE INDEX idx_tcp_executions_start_time ON tcp_executions(start_time);
CREATE INDEX idx_tcp_monitors_enabled ON tcp_monitors(enabled) WHERE enabled = TRUE;

CREATE TRIGGER update_tcp_monitors_updated_at
  BEFORE UPDATE ON tcp_monitors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
