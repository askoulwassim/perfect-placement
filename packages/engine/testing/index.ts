import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor, Answer, AskRequest, DecisionBackend, OpContext, OpOutcome, PolicyConfig } from '@perfect-placement/contracts';
import { FIXTURE_NOW, FIXTURE_SEED_SQL, FIXTURE_VAULT_DIR } from '@perfect-placement/fixtures';
import { BackendUnavailableError } from '@perfect-placement/resolver';
import { type OpenEngineOptions, openEngine } from '../ops/index.js';
import type { RunnerExit, RunnerLauncher, RunnerSpec } from '../ops/runner.js';
import type { EngineServices } from '../ops/services.js';
import { deepMerge } from '../ops/vault.js';
import type { ProfileLlm } from '../profile/deps.js';

/*
 * TEST-ONLY helpers (excluded from the build; exported as `@perfect-placement/engine/testing` for
 * other packages' tests). A temp PP_HOME copied from the synthetic fixture vault, migrations + seed
 * applied, and fakes for every outside dependency: no Kev, LinkedIn, Gmail, network or runner spawn.
 */

export type FakeAnswer = Omit<Answer, 'id'> | undefined;
export type FakeScript = (q: AskRequest['questions'][number], req: AskRequest) => FakeAnswer;

/** A System One backend double. `'down'` fails every call (the resolver falls back). */
export function fakeBackend(name: 'kev' | 'jev' | 'llm', script: FakeScript | 'down'): DecisionBackend & { calls: AskRequest[] } {
  const calls: AskRequest[] = [];
  return {
    name,
    calls,
    async ask(req) {
      calls.push(req);
      if (script === 'down') throw new BackendUnavailableError(name, 'unreachable (test)');
      return {
        answers: req.questions.map((q) => {
          const a = script(q, req);
          if (!a) throw new BackendUnavailableError(name, `no scripted answer for ${q.id}`);
          return { id: q.id, ...a };
        }),
        latencyMs: 3,
      };
    },
    async health() {
      return script === 'down' ? { ok: false } : { ok: true, latencyMs: 3 };
    },
  };
}

/**
 * Records runner launches instead of spawning anything. With `exit`, each launch reports that the
 * runner ended with this result (after `exitAfter`, so a test can finish the run first).
 */
export function fakeLauncher(
  fail?: string,
  exit?: { result: RunnerExit; exitAfter?: Promise<unknown> },
): RunnerLauncher & { specs: RunnerSpec[]; exited: Promise<void>[] } {
  const specs: RunnerSpec[] = [];
  const exited: Promise<void>[] = [];
  return {
    specs,
    exited,
    async launch(spec) {
      specs.push(spec);
      if (fail) throw new Error(fail);
      if (!exit) return { pid: 4242 };
      const p = Promise.resolve(exit.exitAfter).then(() => exit.result);
      exited.push(p.then(() => undefined));
      return { pid: 4242, exit: p };
    },
  };
}

/** A fetch that refuses everything (tests that should never touch the network). */
export const noNetwork = (async (url: string) => {
  throw new Error(`network disabled in tests: ${url}`);
}) as unknown as NonNullable<EngineServices['fetch']>;

export interface FixtureEngine extends ReturnType<typeof openEngine> {
  cleanup(): void;
  launcher: ReturnType<typeof fakeLauncher>;
  kev: ReturnType<typeof fakeBackend>;
}

export interface FixtureOptions extends Omit<OpenEngineOptions, 'home'> {
  /** Scripted Kev answers (default: Kev down, so decisions fall to the agent or a human). */
  kev?: FakeScript | 'down';
  /** Deep patch over the fixture config.json. */
  config?: Record<string, unknown>;
  /** Apply the fixture seed (default true). `false` = the vault files and an empty, migrated db. */
  seed?: boolean;
}

export function openFixtureEngine(opts: FixtureOptions = {}): FixtureEngine {
  const home = mkdtempSync(join(tmpdir(), 'pp-engine-'));
  cpSync(FIXTURE_VAULT_DIR, home, { recursive: true });
  if (opts.config) {
    const file = join(home, 'config.json');
    const merged = deepMerge(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>, opts.config) as unknown as PolicyConfig;
    writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  }
  const kev = fakeBackend('kev', opts.kev ?? 'down');
  const launcher = fakeLauncher();
  const services: EngineServices = {
    fetch: noNetwork,
    // No DNS in tests (#37): MX unknown unless a test injects a fake.
    mx: async () => null,
    freshnessDelayMs: 0,
    launcher,
    env: {},
    ...(opts.services ?? {}),
    backends: { kev, ...(opts.services?.backends ?? {}) },
  };
  const engine = openEngine({ ...opts, home, services });
  if (opts.seed !== false) engine.db.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
  return Object.assign(engine, {
    kev,
    launcher,
    cleanup() {
      engine.close();
      rmSync(home, { recursive: true, force: true });
    },
  });
}

/** Deterministic op context at the fixture clock. */
export function ctxAt(actor: Actor = 'agent', extra: Partial<OpContext> = {}, now: string | (() => Date) = FIXTURE_NOW): OpContext {
  return { actor, now: typeof now === 'function' ? now : () => new Date(now), ...extra };
}

/** A clock that advances one second per call (stable ordering for created_at). */
export function tickingClock(start: string = FIXTURE_NOW): () => Date {
  let t = Date.parse(start);
  return () => {
    t += 1000;
    return new Date(t);
  };
}

/** Unwrap an ok outcome or fail with its error. */
// biome-ignore lint/suspicious/noExplicitAny: test helper returns loosely typed output
export function okOut(o: OpOutcome<unknown>): any {
  if (o.status !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.output;
}

/** A writing-model double for the learn loop: deterministic diffs per component. */
export const fakeProfileLlm: ProfileLlm = {
  async draftDiff({ component, data, event }) {
    if (component === 'dealbreakers') {
      const hard = (data.hard_nos as string[]) ?? [];
      return {
        before: { hard_nos: hard },
        after: { hard_nos: [...hard, 'pure delivery roles'] },
        evidence: [`rejected at ${String(event.payload.stage)}: delivery-heavy role`],
      };
    }
    if (component === 'craft') {
      return {
        before: { level: 'wrong-recollection' },
        after: { level: 'staff' },
        evidence: ['rejected for principal; feedback said staff scope'],
      };
    }
    if (component === 'domain') return null;
    return { before: {}, after: { note: 'x' }, evidence: [] };
  },
};

/** Kev for the learn loop: "does it change?" yes for `changes` (p 0.97), confident apply for every diff. */
export function learnKev(changes: readonly string[], applyP = 0.95): FakeScript {
  return (q, req) => {
    if (req.decision === 'profile.learn') return { value: changes.includes(q.id), p: 0.97 };
    if (req.decision === 'profile.apply_diff') return { value: true, p: applyP };
    return undefined;
  };
}
