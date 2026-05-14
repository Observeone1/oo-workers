-- 0008_status_pages.sql
-- Phase 5.5 — public status pages.
--
-- Adds:
--   status_pages           — one row per public-facing status page (slug + title)
--   status_page_monitors   — many-to-many: which monitors appear on which page,
--                            and in what order
--
-- The public read path lives at GET /status/<slug>, served as a fully
-- server-rendered HTML page so it works without JS / without the SPA shell.
-- Writes are gated behind the same writeAuth that protects /api/monitors.

CREATE TABLE status_pages (
  id          SERIAL PRIMARY KEY,
  slug        VARCHAR(64) UNIQUE NOT NULL,
  title       VARCHAR(255) NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER update_status_pages_updated_at
  BEFORE UPDATE ON status_pages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- monitor_type follows the same convention as monitor_regions /
-- monitor_alert_channels: 'url' | 'api' | 'tcp' | 'udp' | 'qa'. No real FK
-- because the per-type monitor tables are separate; cleanup happens in
-- the application layer on monitor delete.
CREATE TABLE status_page_monitors (
  status_page_id  INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  monitor_type    VARCHAR(16) NOT NULL,
  monitor_id      INTEGER NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (status_page_id, monitor_type, monitor_id)
);

CREATE INDEX idx_status_page_monitors_page ON status_page_monitors(status_page_id);
CREATE INDEX idx_status_page_monitors_monitor ON status_page_monitors(monitor_type, monitor_id);
