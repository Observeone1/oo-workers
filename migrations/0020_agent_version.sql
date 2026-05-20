-- Roadmap follow-up: master-side version-skew warning. Each region
-- caches the agent version it last reported via the X-Agent-Version
-- header on /api/agent/jobs + /api/agent/results. The list endpoint
-- compares against the master's own package.json version and surfaces
-- a `versionSkew` flag the UI renders as a banner so operators don't
-- silently run mixed versions across the fleet.

ALTER TABLE regions
  ADD COLUMN IF NOT EXISTS agent_version VARCHAR(32);
