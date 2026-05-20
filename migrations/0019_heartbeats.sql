-- Heartbeat monitors (Roadmap 8). Inverted check direction: the service
-- pings the worker (POST /heartbeat/:token), and the scheduler tick
-- flips status to OVERDUE when `now() - last_ping_at > period + grace`.
-- No executions table — the ping itself is the event; a single
-- `last_ping_at` and `status` per row carry all state.

CREATE TABLE IF NOT EXISTS heartbeat_monitors (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  -- URL-safe random token used as the public ingest path (no auth on
  -- POST /heartbeat/:token — that's the whole point). 32 random bytes
  -- → 43 base64url chars, fits in 64.
  token           VARCHAR(64) NOT NULL UNIQUE,
  period_seconds  INTEGER NOT NULL,
  grace_seconds   INTEGER NOT NULL DEFAULT 60,
  last_ping_at    TIMESTAMPTZ,
  status          VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT heartbeat_status_valid CHECK (status IN ('PENDING', 'UP', 'OVERDUE'))
);

-- Tick query hits this on every scheduler iteration.
CREATE INDEX IF NOT EXISTS idx_heartbeat_monitors_enabled_status
  ON heartbeat_monitors (enabled, status);

-- Ping endpoint resolves the token to a row on every request.
CREATE INDEX IF NOT EXISTS idx_heartbeat_monitors_token
  ON heartbeat_monitors (token);
