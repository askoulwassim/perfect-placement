-- Migration 005: decision kind `apply.fact_check` (#54): unsupported claims in tailored documents and
-- fill answers go to Needs you (keep / remove / edit).
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested).
--
-- SQLite cannot alter a CHECK, so `decision` is rebuilt with the 12-step procedure, as in 002
-- (https://www.sqlite.org/lang_altertable.html#otheralter): foreign keys off, create new, copy, drop old,
-- rename, recreate indexes, foreign_key_check (the engine runner does the check and turns foreign keys
-- off around migrations; the pragmas cover plain `db.exec` callers). `decision` has no triggers and no
-- foreign keys; no table references it by foreign key (event and profile_diff hold its id as plain text).

PRAGMA foreign_keys = OFF;

CREATE TABLE decision_new (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('freshness.closed','inbox.classify','roles.dedupe','roles.criterion','roles.move','roles.archive','profile.learn','profile.apply_diff','people.classify','outreach.to_gmail','apply.submit','apply.fact_check','other')),
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

INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, '005_fact_check', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
