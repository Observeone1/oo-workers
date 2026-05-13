-- 0005_auth.sql
-- API keys for HTTP auth gate. Single-operator self-host; supports
-- revocation, prefix-based identification, scope-based authorization.
-- Cleartext key format: oo_<43 base64url chars> (32 random bytes encoded).
-- key_prefix is the first 11 chars including "oo_" — used for fast lookup
-- and for human-readable listing. key_hash is argon2id (Bun.password.hash).

CREATE TABLE api_keys (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  key_prefix    VARCHAR(20) NOT NULL,
  key_hash      TEXT NOT NULL,
  scopes        TEXT[] NOT NULL DEFAULT '{write}',
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial unique index: a prefix can be reused once the prior key is revoked,
-- and the index only covers live keys so lookup stays O(log n).
CREATE UNIQUE INDEX idx_api_keys_prefix_active
  ON api_keys(key_prefix) WHERE revoked_at IS NULL;

CREATE TRIGGER update_api_keys_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
