-- 0017_status_incidents.sql
-- Operator-authored incident timeline for public status pages. An
-- incident is a thread of updates (statuspage.io / GitHub-status model),
-- rendered on /status/<slug> above the monitor list. `incidents.severity`
-- is denormalised from the latest update for cheap render-time reads.
-- `incident_updates.body` stores RAW markdown source — it is rendered to
-- safe HTML at request time by src/services/incident-render.ts, never
-- pre-rendered/stored as HTML (so a sanitiser fix needs no migration).

CREATE TABLE incidents (
  id              SERIAL PRIMARY KEY,
  status_page_id  INTEGER NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  title           VARCHAR(255) NOT NULL,
  severity        VARCHAR(16) NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ
);

CREATE TABLE incident_updates (
  id           SERIAL PRIMARY KEY,
  incident_id  INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  severity     VARCHAR(16) NOT NULL,
  body         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_incidents_status_page_id ON incidents(status_page_id);
CREATE INDEX idx_incidents_resolved_at ON incidents(resolved_at);
CREATE INDEX idx_incident_updates_incident_id ON incident_updates(incident_id);

CREATE TRIGGER update_incidents_updated_at
  BEFORE UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
