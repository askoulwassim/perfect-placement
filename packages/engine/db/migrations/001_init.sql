-- Migration 001: initial schema (Wave 0).
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested).
-- Conventions: TEXT ids, ISO 8601 UTC TEXT timestamps, *_json columns hold JSON TEXT,
-- booleans are INTEGER 0/1, md_path / *_path are vault-relative.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE profile_version (
  id         TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  parent_id  TEXT REFERENCES profile_version(id),
  reason     TEXT NOT NULL,
  event_id   TEXT
);

CREATE TABLE profile_component (
  id         TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES profile_version(id),
  key        TEXT NOT NULL CHECK (key IN ('story','craft','domain','work_mode','terms','company','team','growth','dealbreakers','voice','network')),
  kind       TEXT NOT NULL CHECK (kind IN ('filter','weighted','asset')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  weight     REAL,
  data_json  TEXT NOT NULL DEFAULT '{}',
  md_path    TEXT,
  UNIQUE (version_id, key)
);

CREATE TABLE profile_diff (
  id                 TEXT PRIMARY KEY,
  created_at         TEXT NOT NULL,
  component_key      TEXT NOT NULL CHECK (component_key IN ('story','craft','domain','work_mode','terms','company','team','growth','dealbreakers','voice','network')),
  base_version_id    TEXT NOT NULL REFERENCES profile_version(id),
  diff_json          TEXT NOT NULL,
  evidence_json      TEXT NOT NULL DEFAULT '[]',
  impact             TEXT NOT NULL CHECK (impact IN ('low','medium','high')),
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','undone')),
  decision_id        TEXT,
  event_id           TEXT,
  applied_version_id TEXT REFERENCES profile_version(id)
);

CREATE TABLE company (
  id        TEXT PRIMARY KEY,
  slug      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  domain    TEXT,
  ats_type  TEXT NOT NULL DEFAULT 'unknown' CHECK (ats_type IN ('greenhouse','lever','ashby','workday','other','unknown')),
  ats_board TEXT,
  affinity  INTEGER NOT NULL DEFAULT 0 CHECK (affinity BETWEEN -5 AND 5),
  md_path   TEXT
);

CREATE TABLE role (
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
  archive_reason  TEXT CHECK (archive_reason IN ('below_threshold','dealbreaker','closed','rejected','passed','withdrawn','legacy')),
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
CREATE UNIQUE INDEX role_url_uq ON role(url) WHERE url IS NOT NULL;
CREATE INDEX role_ats_job_idx ON role(ats_job_id);
CREATE INDEX role_status_idx ON role(status);
CREATE INDEX role_company_idx ON role(company_id);

-- Append-only: rescores add rows.
CREATE TABLE score (
  id                 TEXT PRIMARY KEY,
  role_id            TEXT NOT NULL REFERENCES role(id),
  profile_version_id TEXT REFERENCES profile_version(id),
  rubric_json        TEXT NOT NULL,
  c1 INTEGER NOT NULL CHECK (c1 BETWEEN 1 AND 5),
  c2 INTEGER NOT NULL CHECK (c2 BETWEEN 1 AND 5),
  c3 INTEGER NOT NULL CHECK (c3 BETWEEN 1 AND 5),
  c4 INTEGER NOT NULL CHECK (c4 BETWEEN 1 AND 5),
  c5 INTEGER NOT NULL CHECK (c5 BETWEEN 1 AND 5),
  c6 INTEGER NOT NULL CHECK (c6 BETWEEN 1 AND 5),
  c7 INTEGER NOT NULL CHECK (c7 BETWEEN 1 AND 5),
  c8 INTEGER NOT NULL CHECK (c8 BETWEEN 1 AND 5),
  c9 INTEGER NOT NULL CHECK (c9 BETWEEN 1 AND 5),
  affinity_mod       REAL NOT NULL DEFAULT 0,
  total              REAL NOT NULL CHECK (total BETWEEN 0 AND 100),
  band               TEXT NOT NULL CHECK (band IN ('green','yellow','red')),
  decision           TEXT NOT NULL CHECK (decision IN ('active','held','archived')),
  facts_json         TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL
);
CREATE INDEX score_role_idx ON score(role_id, created_at);
CREATE TRIGGER score_no_update BEFORE UPDATE ON score BEGIN SELECT RAISE(ABORT, 'score is append-only'); END;
CREATE TRIGGER score_no_delete BEFORE DELETE ON score BEGIN SELECT RAISE(ABORT, 'score is append-only'); END;

-- Append-only.
CREATE TABLE event (
  id           TEXT PRIMARY KEY,
  ts           TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN (
    'role_added','role_scored','role_moved','role_archived','role_held','role_promoted',
    'freshness_checked','role_closed','role_picked','role_skipped',
    'application_tailored','application_submitted','inbox_classified',
    'interview_scheduled','interview_retro','rejection','offer',
    'contact_found','outreach_drafted','outreach_replied',
    'profile_diff_proposed','profile_diff_applied','profile_diff_rejected',
    'decision_made','decision_overridden','decision_undone','run_started','run_finished')),
  subject_type TEXT NOT NULL CHECK (subject_type IN ('role','company','contact','outreach','application','interview','profile','profile_diff','decision','run','system')),
  subject_id   TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  actor        TEXT NOT NULL CHECK (actor IN ('agent','human','schedule')),
  decision_id  TEXT
);
CREATE INDEX event_subject_idx ON event(subject_type, subject_id, ts);
CREATE INDEX event_type_idx ON event(type, ts);
CREATE TRIGGER event_no_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;
CREATE TRIGGER event_no_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT, 'event is append-only'); END;

CREATE TABLE application (
  id                 TEXT PRIMARY KEY,
  role_id            TEXT NOT NULL UNIQUE REFERENCES role(id),
  stage              TEXT NOT NULL CHECK (stage IN ('research','tailor','connect','fill','submit','done')),
  applied_at         TEXT,
  portal_url         TEXT,
  package_paths_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE contact (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  headline     TEXT,
  linkedin_url TEXT UNIQUE,
  email        TEXT,
  source       TEXT NOT NULL CHECK (source IN ('linkedin','gmail','jd','company_site','manual')),
  notes        TEXT
);

CREATE TABLE contact_link (
  id             TEXT PRIMARY KEY,
  contact_id     TEXT NOT NULL REFERENCES contact(id),
  company_id     TEXT REFERENCES company(id),
  role_id        TEXT REFERENCES role(id),
  degree         TEXT NOT NULL CHECK (degree IN ('1','2','cold')),
  tier           TEXT NOT NULL CHECK (tier IN ('warm_hiring','warm_other','bridge','cold_hiring','cold_other')),
  via_contact_id TEXT REFERENCES contact(id),
  is_hiring_team INTEGER NOT NULL DEFAULT 0 CHECK (is_hiring_team IN (0,1)),
  CHECK (company_id IS NOT NULL OR role_id IS NOT NULL)
);
CREATE INDEX contact_link_role_idx ON contact_link(role_id);

CREATE TABLE outreach (
  id             TEXT PRIMARY KEY,
  contact_id     TEXT NOT NULL REFERENCES contact(id),
  role_id        TEXT NOT NULL REFERENCES role(id),
  tier           TEXT NOT NULL CHECK (tier IN ('warm_hiring','warm_other','bridge','cold_hiring','cold_other')),
  gmail_draft_id TEXT,
  status         TEXT NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted','in_gmail','replied','ignored')),
  md_path        TEXT
);

CREATE TABLE interview (
  id         TEXT PRIMARY KEY,
  role_id    TEXT NOT NULL REFERENCES role(id),
  round      INTEGER NOT NULL CHECK (round >= 1),
  at         TEXT,
  prep_path  TEXT,
  retro_path TEXT,
  outcome    TEXT CHECK (outcome IN ('pending','advanced','rejected','offer','withdrawn'))
);

CREATE TABLE decision (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('freshness.closed','inbox.classify','roles.dedupe','roles.criterion','roles.move','roles.archive','profile.learn','profile.apply_diff','people.classify','outreach.to_gmail','apply.submit','other')),
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('role','company','contact','outreach','application','interview','profile','profile_diff','decision','run','system')),
  subject_id     TEXT NOT NULL,
  question_json  TEXT NOT NULL,
  backend        TEXT NOT NULL CHECK (backend IN ('rule','jev','kev','llm','human')),
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
  CHECK (impact <> 'high' OR policy_outcome = 'human')
);
CREATE INDEX decision_queue_idx ON decision(status, policy_outcome, ts);
CREATE INDEX decision_subject_idx ON decision(subject_type, subject_id);

CREATE TABLE run (
  id           TEXT PRIMARY KEY,
  op           TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('running','ok','partial','error')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  log_path     TEXT
);

INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, '001_init', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
