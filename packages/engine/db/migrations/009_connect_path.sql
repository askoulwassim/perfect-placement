-- Migration 009: direct vs bridge for a 2nd-degree hiring-team target (#98). A contact link keeps the path
-- the user picked (null = the ranked default, engine people/path.ts) and the mutual's tie to the target
-- (the connect skill's judgment: same company, same industry, history).
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested). Additive only.

ALTER TABLE contact_link ADD COLUMN path TEXT CHECK (path IS NULL OR path IN ('direct','bridge'));
ALTER TABLE contact_link ADD COLUMN via_tie_json TEXT;

INSERT INTO schema_migrations (version, name, applied_at) VALUES (9, '009_connect_path', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
