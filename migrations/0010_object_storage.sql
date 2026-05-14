-- 0010_object_storage.sql
-- Phase 6 — externalize QA script storage.
--
-- Adds:
--   qa_generated_tests.script_url — when set, the script content lives in
--     object storage at this URL (or relative key). When NULL, the script
--     column is still authoritative (upgrade fallback).
--
-- The application layer (storage-backfill.ts) drains rows with NULL
-- script_url + non-NULL script and uploads them to whatever storage
-- backend OO_OBJECT_STORAGE_ENDPOINT points at. The script column stays
-- around during the v1.0 cycle as a fallback; a follow-up migration in
-- v1.x will drop it once all instances have completed the backfill.

ALTER TABLE qa_generated_tests ADD COLUMN script_url VARCHAR(512);

-- Partial index makes the backfill query cheap: WHERE script_url IS NULL
-- AND script IS NOT NULL.
CREATE INDEX idx_qa_generated_tests_pending_backfill
  ON qa_generated_tests(id)
  WHERE script_url IS NULL AND script IS NOT NULL;
