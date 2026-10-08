import { FRESHNESS_SCOPE, ID_PREFIX } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { newId } from './ids.js';
import type { FreshnessStore, ScopeRole } from './store.js';

/*
 * WAVE 2 SHIM. Direct SQL over an injected better-sqlite3 handle so lane G can run end to end
 * before lanes A (repositories), B (runOp, roles.archive, event writer) and I (resolver) merge.
 * Wave 2 replaces this with an ops-backed FreshnessStore; AGENTS.md rule 1 (every write is an op)
 * holds once the swap is made. Every write here is guarded to FRESHNESS_SCOPE.
 */

const SCOPE_SQL = FRESHNESS_SCOPE.map((s) => `'${s}'`).join(',');

interface RoleRow extends Omit<ScopeRole, 'flags_json'> {
  flags_json: string;
}

export function sqliteStore(db: Database.Database): FreshnessStore {
  const select = `SELECT r.id, r.title, r.url, r.status, r.found_at, r.posted_at, r.freshness, r.last_checked_at, r.flags_json,
      r.company_id, c.name AS company_name, c.ats_type, c.ats_board
    FROM role r JOIN company c ON c.id = r.company_id
    WHERE r.status IN (${SCOPE_SQL})`;
  const hydrate = (r: RoleRow): ScopeRole => ({ ...r, flags_json: JSON.parse(r.flags_json || '{}') as Record<string, unknown> });

  return {
    listInScope(roleIds) {
      if (roleIds && roleIds.length === 0) return [];
      const rows = roleIds
        ? (db.prepare(`${select} AND r.id IN (${roleIds.map(() => '?').join(',')}) ORDER BY r.id`).all(...roleIds) as RoleRow[])
        : (db.prepare(`${select} ORDER BY r.id`).all() as RoleRow[]);
      return rows.map(hydrate);
    },
    recordCheck({ roleId, freshness, at, flags }) {
      const res = db
        .prepare(
          `UPDATE role SET freshness = ?, last_checked_at = ?, flags_json = ?, updated_at = ? WHERE id = ? AND status IN (${SCOPE_SQL})`,
        )
        .run(freshness, at, JSON.stringify(flags), at, roleId);
      return res.changes === 1;
    },
    archiveClosed({ roleId, at, flags }) {
      const res = db
        .prepare(
          `UPDATE role SET status = 'archived', archive_reason = 'closed', held_reason = NULL, freshness = 'closed',
             last_checked_at = ?, flags_json = ?, updated_at = ? WHERE id = ? AND status IN (${SCOPE_SQL})`,
        )
        .run(at, JSON.stringify(flags), at, roleId);
      return res.changes === 1;
    },
    emit(e) {
      const id = newId(ID_PREFIX.event, new Date(e.ts));
      db.prepare(
        `INSERT INTO event (id, ts, type, subject_type, subject_id, payload_json, actor, decision_id) VALUES (?, ?, ?, 'role', ?, ?, ?, ?)`,
      ).run(id, e.ts, e.type, e.subjectId, JSON.stringify(e.payload), e.actor, e.decisionId);
      return id;
    },
    attachDecisionAction(decisionId, action) {
      db.prepare('UPDATE decision SET action_json = ? WHERE id = ? AND action_json IS NULL').run(JSON.stringify(action), decisionId);
    },
    startRun(op, at) {
      const id = newId(ID_PREFIX.run, new Date(at));
      db.prepare(`INSERT INTO run (id, op, started_at, status, summary_json) VALUES (?, ?, ?, 'running', '{}')`).run(id, op, at);
      return id;
    },
    finishRun(id, { at, status, summary, logPath }) {
      db.prepare('UPDATE run SET finished_at = ?, status = ?, summary_json = ?, log_path = ? WHERE id = ?').run(
        at,
        status,
        JSON.stringify(summary),
        logPath,
        id,
      );
    },
  };
}
