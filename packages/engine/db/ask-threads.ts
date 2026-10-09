import { AskThreadRow } from '@perfect-placement/contracts';
import type { Db } from './connection.js';

/*
 * Ask threads (#69, migration 008): engine state kept by `pp up`'s Ask turn so a restart resumes a
 * thread. Conversation state, not job-search data: not an op, never reachable from skills, agents or
 * the MCP server. Only `AskThreads` (engine/ops/ask.ts) calls it.
 */

/** Where Ask threads are kept between `pp up` runs (#69). */
export interface AskThreadStore {
  load(id: string): AskThreadRow | undefined;
  save(row: AskThreadRow): void;
  /** Delete threads last updated before `before` (ISO). Returns how many went. */
  prune(before: string): number;
}

/** Ask threads in the vault's `ask_thread` table. */
export function dbAskThreadStore(db: Db): AskThreadStore {
  return {
    load(id) {
      const raw = db.prepare('SELECT * FROM ask_thread WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!raw) return undefined;
      const parsed = AskThreadRow.safeParse({ ...raw, turns_json: JSON.parse(String(raw.turns_json ?? '[]')) });
      return parsed.success ? parsed.data : undefined;
    },
    save(row) {
      const r = AskThreadRow.parse(row);
      db.prepare(
        `INSERT INTO ask_thread (id, created_at, updated_at, runner, session_id, turns_json)
         VALUES (@id, @created_at, @updated_at, @runner, @session_id, @turns_json)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, runner = excluded.runner,
           session_id = excluded.session_id, turns_json = excluded.turns_json`,
      ).run({ ...r, turns_json: JSON.stringify(r.turns_json) });
    },
    prune(before) {
      return db.prepare('DELETE FROM ask_thread WHERE updated_at < ?').run(before).changes;
    },
  };
}
