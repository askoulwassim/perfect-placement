-- Migration 003: fresh start (docs/v2/wave1-decisions.md #26). No v1 data is ever imported, so the
-- migration-only enum values go: archive reason 'legacy' and role source 'migration'.
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested).
--
-- Fail-safe: any row still carrying a removed value is mapped first (legacy -> passed,
-- migration -> manual), so the rebuild never drops or rejects data.
--
-- SQLite cannot alter a CHECK, so `role` is rebuilt with the 12-step procedure, as in 002
-- (https://www.sqlite.org/lang_altertable.html#otheralter): foreign keys off, create new, copy,
-- drop old, rename, recreate indexes, foreign_key_check (the engine runner does the check and
-- turns foreign keys off around migrations; the pragmas cover plain `db.exec` callers).
-- `role` has no triggers; child tables reference it by name, so their FKs survive the rename.

PRAGMA foreign_keys = OFF;

UPDATE role SET archive_reason = 'passed' WHERE archive_reason = 'legacy';
UPDATE role SET source = 'manual' WHERE source = 'migration';

CREATE TABLE role_new (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id),
  title           TEXT NOT NULL,
  url             TEXT,
  ats_job_id      TEXT,
  source          TEXT NOT NULL CHECK (source IN ('scout','link','watchlist','referral','manual')),
  found_at        TEXT NOT NULL,
  posted_at       TEXT,
  workplace       TEXT NOT NULL DEFAULT 'unspecified' CHECK (workplace IN ('remote','hybrid','onsite','flexible','unspecified')),
  remote_ok       INTEGER CHECK (remote_ok IN (0,1)),
  location        TEXT,
  comp_min        INTEGER,
  comp_max        INTEGER,
  comp_currency   TEXT,
  facing          TEXT CHECK (facing IN ('internal','external','mixed')),
  seniority       TEXT,
  status          TEXT NOT NULL DEFAULT 'inbox' CHECK (status IN ('inbox','active','held','on-deck','draft-ready','applied','interviews','offers','archived')),
  archive_reason  TEXT CHECK (archive_reason IN ('below_threshold','dealbreaker','closed','rejected','passed','withdrawn','duplicate')),
  held_reason     TEXT CHECK (held_reason IN ('company_cap')),
  last_checked_at TEXT,
  freshness       TEXT NOT NULL DEFAULT 'unknown' CHECK (freshness IN ('open','closed','unsure','unknown')),
  flags_json      TEXT NOT NULL DEFAULT '{}',
  md_path         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((status = 'archived') = (archive_reason IS NOT NULL)),
  CHECK ((status = 'held') = (held_reason IS NOT NULL))
);
INSERT INTO role_new (id, company_id, title, url, ats_job_id, source, found_at, posted_at, workplace, remote_ok, location,
  comp_min, comp_max, comp_currency, facing, seniority, status, archive_reason, held_reason, last_checked_at, freshness,
  flags_json, md_path, created_at, updated_at)
SELECT id, company_id, title, url, ats_job_id, source, found_at, posted_at, workplace, remote_ok, location,
  comp_min, comp_max, comp_currency, facing, seniority, status, archive_reason, held_reason, last_checked_at, freshness,
  flags_json, md_path, created_at, updated_at
FROM role;
DROP TABLE role;
ALTER TABLE role_new RENAME TO role;
CREATE UNIQUE INDEX role_url_uq ON role(url) WHERE url IS NOT NULL;
CREATE INDEX role_ats_job_idx ON role(ats_job_id);
CREATE INDEX role_status_idx ON role(status);
CREATE INDEX role_company_idx ON role(company_id);

PRAGMA foreign_keys = ON;

INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, '003_fresh_start', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
