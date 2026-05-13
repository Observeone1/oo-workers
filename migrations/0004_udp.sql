-- 0004_udp.sql
-- UDP probes — sends a datagram (optional hex payload), optionally awaits
-- a response within timeout.

CREATE TABLE udp_monitors (
  id                SERIAL PRIMARY KEY,
  name              VARCHAR(255) NOT NULL,
  description       TEXT,
  host              VARCHAR(255) NOT NULL,
  port              INTEGER NOT NULL,
  payload_hex       TEXT,
  expect_response   BOOLEAN NOT NULL DEFAULT FALSE,
  timeout_ms        INTEGER NOT NULL DEFAULT 5000,
  interval_seconds  INTEGER NOT NULL DEFAULT 60,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE udp_executions (
  id              SERIAL PRIMARY KEY,
  udp_monitor_id  INTEGER NOT NULL REFERENCES udp_monitors(id) ON DELETE CASCADE,
  status          VARCHAR(20) NOT NULL,
  latency_ms      INTEGER,
  response_bytes  INTEGER,
  error_message   TEXT,
  start_time      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_time        TIMESTAMPTZ
);

CREATE INDEX idx_udp_executions_monitor_id ON udp_executions(udp_monitor_id);
CREATE INDEX idx_udp_executions_start_time ON udp_executions(start_time);
CREATE INDEX idx_udp_monitors_enabled ON udp_monitors(enabled) WHERE enabled = TRUE;

CREATE TRIGGER update_udp_monitors_updated_at
  BEFORE UPDATE ON udp_monitors
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
