import { Decision, type DecisionStatus, type EventRow, type PolicyOutcome } from '@perfect-placement/contracts';

/*
 * Decisions log over an injected SQLite handle (better-sqlite3 compatible). Lane A owns the db
 * package and its repositories; until Wave 2 this is the resolver's own thin repository for the
 * `decision` table plus event appends. Structural typing keeps better-sqlite3 a dev dependency.
 */

export interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
export interface SqliteLike {
  prepare(sql: string): SqliteStatement;
}

export interface DecisionFilter {
  statuses?: DecisionStatus[];
  outcomes?: PolicyOutcome[];
  excludeOutcomes?: PolicyOutcome[];
  since?: string;
}

export interface DecisionStore {
  insert(d: Decision): void;
  get(id: string): Decision | undefined;
  update(id: string, patch: Partial<Omit<Decision, 'id'>>): Decision;
  list(filter?: DecisionFilter): Decision[];
  appendEvent(e: EventRow): void;
}

const COLUMNS = [
  'id',
  'ts',
  'kind',
  'subject_type',
  'subject_id',
  'question_json',
  'backend',
  'answer_json',
  'p',
  'impact',
  'policy_outcome',
  'status',
  'human_choice',
  'overridden',
  'undo_until',
  'resolved_at',
  'latency_ms',
  'action_json',
] as const;

function toRow(d: Partial<Decision>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (k.endsWith('_json')) row[k] = v === null || v === undefined ? null : JSON.stringify(v);
    else if (k === 'overridden') row[k] = v ? 1 : 0;
    else row[k] = v;
  }
  return row;
}

function fromRow(row: Record<string, unknown>): Decision {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.endsWith('_json')) out[k] = typeof v === 'string' ? JSON.parse(v) : v;
    else if (k === 'overridden') out[k] = v === 1;
    else out[k] = v;
  }
  return Decision.parse(out);
}

export function createSqliteDecisionStore(db: SqliteLike): DecisionStore {
  const insertStmt = db.prepare(`INSERT INTO decision (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map((c) => `@${c}`).join(', ')})`);
  const getStmt = db.prepare('SELECT * FROM decision WHERE id = ?');
  const eventStmt = db.prepare(
    'INSERT INTO event (id, ts, type, subject_type, subject_id, payload_json, actor, decision_id) VALUES (@id, @ts, @type, @subject_type, @subject_id, @payload_json, @actor, @decision_id)',
  );
  const get = (id: string): Decision | undefined => {
    const row = getStmt.get(id) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : undefined;
  };
  return {
    insert(d) {
      insertStmt.run(toRow(Decision.parse(d)));
    },
    get,
    update(id, patch) {
      const keys = Object.keys(patch).filter((k) => (COLUMNS as readonly string[]).includes(k) && k !== 'id');
      if (keys.length) {
        db.prepare(`UPDATE decision SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...toRow(patch), id });
      }
      const d = get(id);
      if (!d) throw new Error(`decision ${id} not found`);
      return d;
    },
    list(filter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.statuses?.length) {
        where.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
        params.push(...filter.statuses);
      }
      if (filter.outcomes?.length) {
        where.push(`policy_outcome IN (${filter.outcomes.map(() => '?').join(',')})`);
        params.push(...filter.outcomes);
      }
      if (filter.excludeOutcomes?.length) {
        where.push(`policy_outcome NOT IN (${filter.excludeOutcomes.map(() => '?').join(',')})`);
        params.push(...filter.excludeOutcomes);
      }
      if (filter.since) {
        where.push('ts >= ?');
        params.push(filter.since);
      }
      const sql = `SELECT * FROM decision ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ts DESC, id DESC`;
      return db
        .prepare(sql)
        .all(...params)
        .map((r) => fromRow(r as Record<string, unknown>));
    },
    appendEvent(e) {
      eventStmt.run({ ...e, payload_json: JSON.stringify(e.payload_json) });
    },
  };
}
