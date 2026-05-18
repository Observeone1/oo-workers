-- 0014_db.sql
-- Optional per-monitor TLS for db liveness checks. When true, the probe
-- wraps the socket in TLS before sending the liveness bytes (rediss://,
-- stunnel-wrapped postgres/mysql). Default false = today's plaintext
-- behavior, so existing rows are unaffected.

ALTER TABLE db_monitors ADD COLUMN tls BOOLEAN NOT NULL DEFAULT FALSE;
