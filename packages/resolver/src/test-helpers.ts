import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OpOutcome, RunOp } from '@perfect-placement/contracts';
import { FIXTURE_SEED_SQL } from '@perfect-placement/fixtures';
import Database from 'better-sqlite3';

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
