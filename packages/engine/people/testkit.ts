import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AskFn,
  type AskRequest,
  type AskResult,
  DEFAULT_CONFIG,
  type OpContext,
  POLICY_GRID,
  type PolicyConfig,
  type PolicyOutcome,
  thresholdsFor,
} from '@perfect-placement/contracts';
import Database from 'better-sqlite3';
import { listMigrations, MIGRATIONS_DIR } from '../db/index.js';
import { defaultNewId } from './ids.js';
import type { PeopleDeps } from './types.js';

/*
 * WAVE2-SHIM test kit. Lanes A (db), B (runOp) and I (resolver) are not merged in Wave 1, so lane H
 * tests run against: a temp vault copied from fixtures, a temp better-sqlite3 db built from
 * migration 001 + the fixture seed, and a scripted fake `ask` that writes decision rows the way
 * lane I will. Never touches PP_HOME.
 */

export interface TestVault {
  dir: string;
  db: Database.Database;
  cleanup(): void;
}

export function createTestVault(fixtureVaultDir: string, seedSqlPath: string): TestVault {
  const dir = mkdtempSync(join(tmpdir(), 'pp-lane-h-'));
  cpSync(fixtureVaultDir, dir, { recursive: true });
  const db = new Database(join(dir, 'pp.db'));
  db.pragma('foreign_keys = ON');
  for (const f of listMigrations()) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  db.exec(readFileSync(seedSqlPath, 'utf8'));
  return {
    dir,
    db,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type ScriptedAnswer = { value: string | boolean | number; p: number };

/** Fake resolver: scripted answers per subject id, policy from the locked grid, one decision row per answer. */
export function createFakeAsk(
  db: Database.Database,
  script: (req: AskRequest) => ScriptedAnswer,
  opts: { config?: PolicyConfig; now?: () => Date } = {},
): AskFn & { calls: AskRequest[] } {
  const config = opts.config ?? DEFAULT_CONFIG;
  const now = opts.now ?? (() => new Date('2026-10-08T12:00:00.000Z'));
  const calls: AskRequest[] = [];
  const fn = async (req: AskRequest): Promise<AskResult> => {
    calls.push(req);
    const t = thresholdsFor(config, req.decision);
    const answers = [];
    const decisionIds: string[] = [];
    const outcomes: PolicyOutcome[] = [];
    for (const q of req.questions) {
      const a = script(req);
      const band = a.p >= t.auto ? 'confident' : a.p >= t.second_opinion ? 'middle' : 'low';
      // Fake second backend never agrees, so auto_second falls to human (the conservative path).
      let outcome = POLICY_GRID[req.impact][band];
      if (outcome === 'auto_second') outcome = 'human';
      const id = defaultNewId('dc');
      db.prepare(
        `INSERT INTO decision (id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact, policy_outcome, status, latency_ms)
         VALUES (?, ?, ?, ?, ?, ?, 'kev', ?, ?, ?, ?, ?, 0)`,
      ).run(
        id,
        now().toISOString(),
        req.decision,
        req.subject?.type ?? 'system',
        req.subject?.id ?? 'system',
        JSON.stringify({ ...q, state: req.state }),
        JSON.stringify({ id: q.id, value: a.value, p: a.p }),
        a.p,
        req.impact,
        outcome,
        outcome === 'human' ? 'pending' : 'applied',
      );
      answers.push({ id: q.id, value: a.value, p: a.p });
      decisionIds.push(id);
      outcomes.push(outcome);
    }
    return { answers, backend: 'kev', latencyMs: 1, decisionIds, outcomes };
  };
  return Object.assign(fn, { calls });
}

export const testCtx = (over: Partial<OpContext> = {}): OpContext => ({
  actor: 'agent',
  now: () => new Date('2026-10-08T12:00:00.000Z'),
  ...over,
});

export function testDeps(v: TestVault, over: Partial<PeopleDeps> & Pick<PeopleDeps, 'ask'>): PeopleDeps {
  return { db: v.db, vaultDir: v.dir, config: DEFAULT_CONFIG, ...over };
}
