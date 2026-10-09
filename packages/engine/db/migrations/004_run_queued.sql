-- Migration 004: run status `queued` (#21, ahead of the run queue #30).
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested).
--
-- SQLite cannot alter a CHECK, so `run` is rebuilt (create new, copy, drop old, rename). `run` has no
-- indexes besides its primary key, no triggers, and no table references it by foreign key.

CREATE TABLE run_new (
  id           TEXT PRIMARY KEY,
  op           TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('queued','running','ok','partial','error')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  log_path     TEXT
);
INSERT INTO run_new (id, op, started_at, finished_at, status, summary_json, log_path)
SELECT id, op, started_at, finished_at, status, summary_json, log_path FROM run;
DROP TABLE run;
ALTER TABLE run_new RENAME TO run;

INSERT INTO schema_migrations (version, name, applied_at) VALUES (4, '004_run_queued', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
