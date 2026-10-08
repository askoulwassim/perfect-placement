-- Migration 002: Wave 2 contract changes (docs/v2/wave2-plan.md, Phase 1).
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested).
-- 1. onboard_session table (lane E).
-- 2. role: archive reason 'duplicate' (lane B). SQLite cannot alter a CHECK, so the table is rebuilt.
-- 3. decision: backend 'agent' (wave1-decisions #9); the high-impact CHECK becomes
--    `kind <> 'apply.submit' OR policy_outcome = 'human'` (wave1-decisions #24 hard exclusion;
--    the rest of the exclusion list is enforced in code by isHardHuman).
--
-- Table rebuilds follow SQLite's 12-step procedure (https://www.sqlite.org/lang_altertable.html#otheralter):
-- foreign keys off, create new, copy, drop old, rename, recreate indexes + triggers, foreign_key_check.
-- `PRAGMA foreign_keys` is a no-op inside a transaction, so the engine runner turns foreign keys off
-- around migrations and runs PRAGMA foreign_key_check before commit (packages/engine/db/connection.ts);
-- the pragma below covers plain `db.exec` callers (no transaction).

PRAGMA foreign_keys = OFF;

-- 1 ---------------------------------------------------------------- onboard_session

CREATE TABLE onboard_session (
  id               TEXT PRIMARY KEY,
  started_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  step             TEXT NOT NULL CHECK (step IN ('resume','interview','calibrate','confirm','done')),
  scope_json       TEXT,
  draft_json       TEXT NOT NULL DEFAULT '{}',
  sources_json     TEXT NOT NULL DEFAULT '{}',
  answered_json    TEXT NOT NULL DEFAULT '[]',
  calibration_json TEXT NOT NULL DEFAULT '{}',
  version_id       TEXT REFERENCES profile_version(id)
);
CREATE INDEX onboard_session_updated_idx ON onboard_session(updated_at);

-- 2 ---------------------------------------------------------------- role

CREATE TABLE role_new (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES company(id),
  title           TEXT NOT NULL,
  url             TEXT,
  ats_job_id      TEXT,
  source          TEXT NOT NULL CHECK (source IN ('scout','link','watchlist','referral','migration','manual')),
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
  archive_reason  TEXT CHECK (archive_reason IN ('below_threshold','dealbreaker','closed','rejected','passed','withdrawn','legacy','duplicate')),
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

-- 3 ---------------------------------------------------------------- decision

CREATE TABLE decision_new (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('freshness.closed','inbox.classify','roles.dedupe','roles.criterion','roles.move','roles.archive','profile.learn','profile.apply_diff','people.classify','outreach.to_gmail','apply.submit','other')),
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('role','company','contact','outreach','application','interview','profile','profile_diff','decision','run','system')),
  subject_id     TEXT NOT NULL,
  question_json  TEXT NOT NULL,
  backend        TEXT NOT NULL CHECK (backend IN ('rule','jev','kev','llm','agent','human')),
  answer_json    TEXT NOT NULL,
  p              REAL NOT NULL CHECK (p BETWEEN 0 AND 1),
  impact         TEXT NOT NULL CHECK (impact IN ('low','medium','high')),
  policy_outcome TEXT NOT NULL CHECK (policy_outcome IN ('auto','auto_second','auto_undo','human')),
  status         TEXT NOT NULL CHECK (status IN ('pending','applied','rejected','undone','expired')),
  human_choice   TEXT,
  overridden     INTEGER NOT NULL DEFAULT 0 CHECK (overridden IN (0,1)),
  undo_until     TEXT,
  resolved_at    TEXT,
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  action_json    TEXT,
  CHECK (kind <> 'apply.submit' OR policy_outcome = 'human')
);
INSERT INTO decision_new (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact,
  policy_outcome, status, human_choice, overridden, undo_until, resolved_at, latency_ms, action_json)
SELECT id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact,
  policy_outcome, status, human_choice, overridden, undo_until, resolved_at, latency_ms, action_json
FROM decision;
DROP TABLE decision;
ALTER TABLE decision_new RENAME TO decision;
CREATE INDEX decision_queue_idx ON decision(status, policy_outcome, ts);
CREATE INDEX decision_subject_idx ON decision(subject_type, subject_id);

PRAGMA foreign_keys = ON;

INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, '002_wave2', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
