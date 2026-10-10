-- Migration 009: direct vs bridge for a 2nd-degree hiring-team target (#98).
-- A contact link keeps the path the user picked (null = the ranked default, engine people/path.ts) and the
-- mutual's tie to the target (the connect skill's judgment: same company, same industry, history).
-- Outreach is filed under the person it is addressed to: a bridge intro under the mutual, with
-- `about_contact_id` naming the target it is about, so a role can hold a direct note to the target and a
-- bridge intro to the mutual side by side. Existing bridge drafts (filed under the target) are refiled
-- under their mutual; their vault file keeps its path (md_path is stored, never derived).
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested). Additive only.

ALTER TABLE contact_link ADD COLUMN path TEXT CHECK (path IS NULL OR path IN ('direct','bridge'));
ALTER TABLE contact_link ADD COLUMN via_tie_json TEXT;

ALTER TABLE outreach ADD COLUMN about_contact_id TEXT REFERENCES contact(id);

UPDATE outreach SET
  about_contact_id = contact_id,
  contact_id = (
    SELECT l.via_contact_id FROM contact_link l
    WHERE l.contact_id = outreach.contact_id AND l.role_id = outreach.role_id AND l.via_contact_id IS NOT NULL
    ORDER BY l.id LIMIT 1
  )
WHERE tier = 'bridge' AND EXISTS (
  SELECT 1 FROM contact_link l
  WHERE l.contact_id = outreach.contact_id AND l.role_id = outreach.role_id AND l.via_contact_id IS NOT NULL
);

INSERT INTO schema_migrations (version, name, applied_at) VALUES (9, '009_connect_path', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
