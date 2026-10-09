-- Migration 006: contact emails (#37). A contact's email gets its source and confidence, and decision
-- kind `people.email` (which address to use for a contact) goes to Needs you when a guess is unsure.
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested).
--
-- `contact` only gains columns (ALTER TABLE ADD COLUMN; SQLite allows a CHECK on an added column).
-- Existing addresses are backfilled as known: Gmail / LinkedIn / manual at 1, JD and company site as
-- `public` at 0.9. `decision` is rebuilt with the 12-step procedure, exactly as in 005.

ALTER TABLE contact ADD COLUMN email_source TEXT
  CHECK (email_source IS NULL OR email_source IN ('gmail','linkedin','public','pattern','provider','manual'));
ALTER TABLE contact ADD COLUMN email_confidence REAL
  CHECK (email_confidence IS NULL OR email_confidence BETWEEN 0 AND 1);

UPDATE contact SET
  email_source = CASE source WHEN 'gmail' THEN 'gmail' WHEN 'linkedin' THEN 'linkedin' WHEN 'manual' THEN 'manual' ELSE 'public' END,
  email_confidence = CASE source WHEN 'jd' THEN 0.9 WHEN 'company_site' THEN 0.9 ELSE 1 END
WHERE email IS NOT NULL;

PRAGMA foreign_keys = OFF;

CREATE TABLE decision_new (
  id             TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('freshness.closed','inbox.classify','roles.dedupe','roles.criterion','roles.move','roles.archive','profile.learn','profile.apply_diff','people.classify','outreach.to_gmail','apply.submit','apply.fact_check','people.email','other')),
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

INSERT INTO schema_migrations (version, name, applied_at) VALUES (6, '006_contact_email', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
