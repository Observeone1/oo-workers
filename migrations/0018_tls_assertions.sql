-- 0018_tls_assertions.sql
-- "Note B" follow-up to 0016: opt-in chain / hostname / CN-or-SAN-regex
-- assertions for the TLS monitor. All THREE default OFF so the existing
-- self-signed-friendly expiry-only posture is byte-identical unless the
-- operator explicitly opts in. Independent knobs on purpose — a pinned
-- internal-CA cert may want hostname asserted without public-chain trust,
-- and a public cert reached by IP may want chain without hostname.
ALTER TABLE tls_monitors
  ADD COLUMN verify_chain    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN verify_hostname BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN expect_cn_regex VARCHAR(255);
