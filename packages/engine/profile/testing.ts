import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Answer,
  type AskFn,
  type AskRequest,
  DEFAULT_CONFIG,
  type Impact,
  POLICY_GRID,
  type PolicyConfig,
  type PolicyOutcome,
  thresholdsFor,
} from '@perfect-placement/contracts';
import Database from 'better-sqlite3';
import { listMigrations, MIGRATIONS_DIR } from '../db/index.js';
import { createDbEmitter, type Db, newId, type ProfileDeps } from './deps.js';
import { createMemoryOnboardStore } from './onboard-store.js';

/*
 * WAVE 2 SHIMS + test helpers. Nothing here is production code:
 *  - createTempDb: temp better-sqlite3 db with migrations (+ optional seed SQL). Lane A replaces.
 *  - createFakeResolver: scripted answers, policy from POLICY_GRID, writes decision rows. Lane I replaces.
 *  - createDecisionActionAttacher: sets decision.action_json. Replaced by AskRequest.action.
 */

export function createTempDb(seedSqlPath?: string): { db: Db; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'pp-lane-e-'));
  const db = new Database(join(dir, 'pp.db'));
  for (const f of listMigrations(MIGRATIONS_DIR)) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  if (seedSqlPath) db.exec(readFileSync(seedSqlPath, 'utf8'));
  return {
    db,
    dir,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Script = (
  q: { id: string; type: string; instructions: string },
  req: AskRequest,
) => { value: Answer['value']; p: number } | undefined;

function decide(p: number, impact: Impact, t: { auto: number; second_opinion: number }): PolicyOutcome {
  const band = p >= t.auto ? 'confident' : p >= t.second_opinion ? 'middle' : 'low';
  // High stays human, as in lane I's decide() until Phase 2 wires isHardHuman (wave1-decisions #24).
  return impact === 'high' ? 'human' : POLICY_GRID[impact][band];
}

/**
 * Fake resolver: answers from `script` (default: noulli false @0.95, choice 'other', score min).
 * `auto_second` is treated as "second backend agreed" (as the real resolver returns it only then).
 */
export function createFakeResolver(db: Db, script: Script, config: PolicyConfig = DEFAULT_CONFIG): AskFn & { calls: AskRequest[] } {
  const calls: AskRequest[] = [];
  const ask = (async (req: AskRequest) => {
    calls.push(req);
    const t = thresholdsFor(config, req.decision);
    const now = new Date();
    const answers: Answer[] = [];
    const outcomes: PolicyOutcome[] = [];
    const decisionIds: string[] = [];
    for (const q of req.questions) {
      const s = script(q, req) ?? { value: q.type === 'noulli' ? false : q.type === 'score' ? q.min : 'other', p: 0.95 };
      const a: Answer = { id: q.id, value: s.value, p: s.p };
      const outcome = decide(s.p, req.impact, t);
      const id = newId('dc', now);
      db.prepare(
        `INSERT INTO decision (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact, policy_outcome, status, human_choice, overridden, undo_until, resolved_at, latency_ms, action_json)
         VALUES (?, ?, ?, ?, ?, ?, 'llm', ?, ?, ?, ?, ?, NULL, 0, ?, ?, 1, NULL)`,
      ).run(
        id,
        now.toISOString(),
        req.decision,
        req.subject?.type ?? 'system',
        req.subject?.id ?? 'none',
        JSON.stringify({ ...q, state: req.state }),
        JSON.stringify(a),
        s.p,
        req.impact,
        outcome,
        outcome === 'human' ? 'pending' : 'applied',
        outcome === 'auto_undo' ? new Date(now.getTime() + t.undo_hours * 3600_000).toISOString() : null,
        outcome === 'human' ? null : now.toISOString(),
      );
      answers.push(a);
      outcomes.push(outcome);
      decisionIds.push(id);
    }
    return { answers, backend: 'llm' as const, latencyMs: 1, decisionIds, outcomes };
  }) as AskFn & { calls: AskRequest[] };
  ask.calls = calls;
  return ask;
}

export function createDecisionActionAttacher(db: Db): NonNullable<ProfileDeps['attachAction']> {
  const stmt = db.prepare('UPDATE decision SET action_json = ? WHERE id = ?');
  return (id, action) => {
    stmt.run(JSON.stringify(action), id);
  };
}

/** Human resolves a queued decision (what decisions.resolve will do in lane I). */
export function resolveDecisionAsHuman(db: Db, id: string, choice: string, now = new Date()): void {
  db.prepare(`UPDATE decision SET human_choice = ?, resolved_at = ?, status = 'applied' WHERE id = ?`).run(choice, now.toISOString(), id);
}

export function testDeps(db: Db, extra: Partial<ProfileDeps> = {}): ProfileDeps {
  return {
    db,
    emit: createDbEmitter(db),
    onboardStore: createMemoryOnboardStore(),
    attachAction: createDecisionActionAttacher(db),
    ...extra,
  };
}
