-- Migration 012: team-side targets (#132).
-- A contact link can be on the team side without being on the hiring team (the connect skill's judgment: works
-- at the company or one of its product brands, in the role's org or an adjacent function). A 2nd-degree
-- team-side target with a mutual gets ranked direct / bridge paths like a hiring-team target (engine
-- people/path.ts). `brand` keeps the product brand they work under when it differs from the company name.
-- Existing rows stay off the team side (0) with no brand: re-running Connect sets them.
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested). Additive only.

ALTER TABLE contact_link ADD COLUMN team_side INTEGER NOT NULL DEFAULT 0 CHECK (team_side IN (0,1));
ALTER TABLE contact_link ADD COLUMN brand TEXT;

INSERT INTO schema_migrations (version, name, applied_at) VALUES (12, '012_team_side', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
