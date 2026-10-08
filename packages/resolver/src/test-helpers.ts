import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Decision, type OpOutcome, type RunOp } from '@perfect-placement/contracts';
import { FIXTURE_SEED_SQL } from '@perfect-placement/fixtures';
import Database from 'better-sqlite3';
import type { DecisionStore } from './store.js';

/* Test-only helpers. Excluded from the build (tsconfig.build.json). */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../engine/db/migrations', import.meta.url));

export function tempDb(opts: { seed?: boolean } = {}): { db: Database.Database; dir: string; close(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'pp-resolver-'));
  const db = new Database(join(dir, 'pp.db'));
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  }
  if (opts.seed) db.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
  return {
    db,
    dir,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export interface RecordedOp {
  name: string;
  input: unknown;
  actor: string;
  decisionId?: string;
}

/** A RunOp double: records calls, returns `respond(name)` or ok. */
export function fakeRunOp(respond?: (name: string, input: unknown) => OpOutcome<unknown> | undefined): RunOp & { calls: RecordedOp[] } {
  const calls: RecordedOp[] = [];
  const fn = (async (name: string, input: unknown, ctx) => {
    calls.push({ name, input, actor: ctx.actor, ...(ctx.decisionId ? { decisionId: ctx.decisionId } : {}) });
    return respond?.(name, input) ?? { status: 'ok', output: {}, eventIds: [] };
  }) as RunOp & { calls: RecordedOp[] };
  fn.calls = calls;
  return fn;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteLike {
  prepare(sql: string): SqliteStatement;
}

/** Test-only DecisionStore over a raw SQLite handle (production uses lane A's repository in the engine). */
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
