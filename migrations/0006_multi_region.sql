-- 0006_multi_region.sql
-- Phase 4 M1 — multi-region master-side dispatch.
--
-- Adds:
--   regions          — registered probe origins (master itself is implicit when no rows match)
--   monitor_regions  — many-to-many: which regions run each monitor
--   *_executions.region_id — pins each execution to the region that ran it
--
-- Agents authenticate with an existing api_keys row whose scopes include 'agent'.
-- regions.api_key_id binds the key to exactly one region. Revoking the key
-- (via api_keys.revoked_at) takes the region offline; deleting the region
-- cascades to monitor_regions (but not to the api_keys row).

CREATE TABLE regions (
  id            SERIAL PRIMARY KEY,
  slug          VARCHAR(64) UNIQUE NOT NULL,
  label         VARCHAR(255) NOT NULL,
  api_key_id    INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_regions_api_key_id ON regions(api_key_id);

CREATE TRIGGER update_regions_updated_at
  BEFORE UPDATE ON regions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- monitor_type is one of 'url' | 'api' | 'tcp' | 'udp' | 'qa'. Not a real FK
-- because the per-type monitor tables are separate.
CREATE TABLE monitor_regions (
  monitor_type  VARCHAR(16) NOT NULL,
  monitor_id    INTEGER NOT NULL,
  region_id     INTEGER NOT NULL REFERENCES regions(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (monitor_type, monitor_id, region_id)
);

CREATE INDEX idx_monitor_regions_monitor ON monitor_regions(monitor_type, monitor_id);
CREATE INDEX idx_monitor_regions_region ON monitor_regions(region_id);

-- region_id nullable on every executions table. NULL means "ran on master"
-- (back-compat for single-node operators who never configure a region).
ALTER TABLE url_monitor_executions ADD COLUMN region_id INTEGER REFERENCES regions(id) ON DELETE SET NULL;
ALTER TABLE api_executions         ADD COLUMN region_id INTEGER REFERENCES regions(id) ON DELETE SET NULL;
ALTER TABLE tcp_executions         ADD COLUMN region_id INTEGER REFERENCES regions(id) ON DELETE SET NULL;
ALTER TABLE udp_executions         ADD COLUMN region_id INTEGER REFERENCES regions(id) ON DELETE SET NULL;
ALTER TABLE qa_test_executions     ADD COLUMN region_id INTEGER REFERENCES regions(id) ON DELETE SET NULL;

CREATE INDEX idx_url_monitor_executions_region_id ON url_monitor_executions(region_id);
CREATE INDEX idx_api_executions_region_id         ON api_executions(region_id);
CREATE INDEX idx_tcp_executions_region_id         ON tcp_executions(region_id);
CREATE INDEX idx_udp_executions_region_id         ON udp_executions(region_id);
CREATE INDEX idx_qa_test_executions_region_id     ON qa_test_executions(region_id);
