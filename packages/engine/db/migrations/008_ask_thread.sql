-- Migration 008: Ask threads survive a `pp up` restart (#69). One row per Ask (Cmd+K) thread: the runner
-- it ran on, the runner's session id (Claude Code `--resume`), and the last turns (capped at 20, replayed
-- for Codex and Cursor). Threads not updated for 30 days are pruned by `pp up`.
-- Must match packages/contracts/src/entities.ts TABLES exactly (tested). Additive only.

CREATE TABLE ask_thread (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  runner      TEXT NOT NULL CHECK (runner IN ('claude','codex','cursor-agent')),
  session_id  TEXT,
  turns_json  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX ask_thread_updated_idx ON ask_thread(updated_at);

INSERT INTO schema_migrations (version, name, applied_at) VALUES (8, '008_ask_thread', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
