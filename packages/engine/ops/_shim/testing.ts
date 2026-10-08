import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, OpContext } from '@perfect-placement/contracts';
import { FIXTURE_NOW, FIXTURE_SEED_SQL, FIXTURE_VAULT_DIR } from '@perfect-placement/fixtures';
import { type OpenEngineOptions, openEngine } from '../index.js';

/*
 * Test helper: a temp PP_HOME copied from the synthetic fixture vault, with migrations
 * and the fixture seed applied. Never touches the real ~/.perfect-placement.
 */

export interface FixtureEngine extends ReturnType<typeof openEngine> {
  cleanup(): void;
}

export function openFixtureEngine(opts: Omit<OpenEngineOptions, 'home'> = {}): FixtureEngine {
  const home = mkdtempSync(join(tmpdir(), 'pp-lane-b-'));
  cpSync(FIXTURE_VAULT_DIR, home, { recursive: true });
  const engine = openEngine({ ...opts, home });
  engine.db.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
  return Object.assign(engine, {
    cleanup() {
      engine.close();
      rmSync(home, { recursive: true, force: true });
    },
  });
}

/** Deterministic op context at the fixture clock. */
export function ctxAt(actor: Actor = 'agent', extra: Partial<OpContext> = {}, now = FIXTURE_NOW): OpContext {
  return { actor, now: () => new Date(now), ...extra };
}
