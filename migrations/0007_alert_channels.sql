-- 0007_alert_channels.sql
-- Phase 5 — alert channel routing.
--
-- Adds:
--   alert_channels         — destinations to notify on monitor status changes
--   monitor_alert_channels — many-to-many: which channels each monitor alerts to
--   *_executions.alerted_at — set when we've dispatched an alert for a transition,
--                             so the next tick on the same status doesn't re-fire
--
-- Channel types: 'webhook' (raw JSON POST), 'discord' (rich embed via incoming
-- webhook), 'slack' (block kit via incoming webhook). Config is jsonb so we can
-- add per-type fields later (custom headers, mention strings, etc.) without a
-- migration.
--
-- Trigger model: alerts fire on status TRANSITION only (SUCCESS → FAILED for
-- outage, FAILED → SUCCESS for recovery). Sustained failure stays quiet.

CREATE TABLE alert_channels (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  type        VARCHAR(32) NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alert_channels_enabled ON alert_channels(enabled) WHERE enabled = TRUE;

CREATE TRIGGER update_alert_channels_updated_at
  BEFORE UPDATE ON alert_channels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- monitor_type follows the same convention as monitor_regions:
-- 'url' | 'api' | 'tcp' | 'udp' | 'qa'. Not a real FK because the per-type
-- monitor tables are separate; the application layer cleans up on monitor
-- delete by deleting matching (monitor_type, monitor_id) rows here.
CREATE TABLE monitor_alert_channels (
  monitor_type  VARCHAR(16) NOT NULL,
  monitor_id    INTEGER NOT NULL,
  channel_id    INTEGER NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (monitor_type, monitor_id, channel_id)
);

CREATE INDEX idx_monitor_alert_channels_monitor ON monitor_alert_channels(monitor_type, monitor_id);
CREATE INDEX idx_monitor_alert_channels_channel ON monitor_alert_channels(channel_id);
