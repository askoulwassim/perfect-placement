-- Migration 011: the fill assist (#106).
-- A fill run with assist uploads the rendered resume and cover letter PDFs and fills the answer fields in the
-- portal, stops before Submit and reports with `apply.fill_done`; the report is kept on the application so the
-- Role screen's primary becomes Open portal. Rendered files are recorded in package_paths_json (no column).
-- Existing rows stay NULL (no assist yet).
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested). Additive only.

ALTER TABLE application ADD COLUMN fill_assist_json TEXT;

INSERT INTO schema_migrations (version, name, applied_at) VALUES (11, '011_fill_assist', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
