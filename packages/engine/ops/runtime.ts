import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type DecisionAction,
  type DecisionKind,
  type EventType,
  isHardHuman,
  OPS,
  type OpContext,
  type OpDef,
  type OpName,
  type OpOutcome,
  type PolicyConfig,
  type RunOp,
  type SubjectType,
  vaultPath,
} from '@perfect-placement/contracts';
import { backendsFromConfig, createResolver, type ResolverInstance } from '@perfect-placement/resolver';
import type Database from 'better-sqlite3';
import type { z } from 'zod';
import { type Repos, repos } from '../db/repo.js';
import { createDecisionStore } from './decision-store.js';
import { OpError } from './errors.js';
import { newId, slugify } from './ids.js';
import { hardHumanHint } from './policy.js';
import { get, insert, select, update } from './rows.js';
import type { EngineServices } from './services.js';
import { readConfig, renderMarkdown, VaultTx } from './vault.js';

/*
 * The single entry point: `runOp(name, input, ctx)`.
 * 1. look up the op, refuse unimplemented ones, validate input with zod
 * 2. optional async `prepare` (network) outside the write lock
 * 3. one write transaction per top-level op (top-level writes are serialized); an op run from inside
 *    another op (a decision's action, a rescore, the learn loop) runs in a SAVEPOINT of its parent
 * 4. gate (wave1-decisions #17, #24): human-only ops and hard exclusions from automated actors go to
 *    Needs you; medium/high static ops from automated actors go through the policy grid with
 *    `ctx.confidence` (no confidence = Needs you); a live decision whose action is this op authorizes it
 * 5. run the handler (it may await the resolver or nested ops); vault writes flush after commit
 * 6. validate the output against the contract, return the event ids it wrote
 */

export type AnyOpName = OpName;
type AllOps = typeof OPS;
export type HandlerInput<N extends AnyOpName> = z.output<AllOps[N]['input']>;
export type HandlerOutput<N extends AnyOpName> = z.input<AllOps[N]['output']>;

export const ALL_OPS: Record<AnyOpName, OpDef> = OPS;

const REQUIRES_HUMAN = Symbol('requires_human');
export interface RequiresHuman {
  [REQUIRES_HUMAN]: true;
  decisionId: string;
}
export const requiresHuman = (decisionId: string): RequiresHuman => ({ [REQUIRES_HUMAN]: true, decisionId });
export const isRequiresHuman = (v: unknown): v is RequiresHuman => typeof v === 'object' && v !== null && REQUIRES_HUMAN in v;

export interface RunLogEntry {
  title: string;
  lines: string[];
  summary: Record<string, unknown>;
}

/** Read-only context for the async `prepare` phase (network). */
export interface PrepareContext {
  db: Database.Database;
  ctx: OpContext;
  config: PolicyConfig;
  home: string;
  services: EngineServices;
}

/** What a handler gets inside the transaction. */
export interface HandlerContext extends PrepareContext {
  name: AnyOpName;
  def: OpDef;
  /** Lane A repositories: the only db access. */
  repos: Repos;
  vault: VaultTx;
  /** Lane I resolver for this call (rule -> Kev -> agent -> human), logging through lane A repos. */
  resolver: ResolverInstance;
  /** Run another op inside this one (savepoint; rolls back with it). */
  runOp: RunOp;
  nowIso(): string;
  /** Write one event row. `type` must be in the op's `emits`. */
  emit(type: EventType, subjectType: SubjectType, subjectId: string, payload?: Record<string, unknown>, decisionId?: string | null): string;
  /** Can this op emit `type`? */
  canEmit(type: EventType): boolean;
  /** Record a run log: appended to ctx.runId's log, or a new finished run for this op. */
  runLog(entry: RunLogEntry): void;
  /** The inverse op for this call; stored as `action_json.undo` when the gate decided auto + undo. */
  setUndo(call: { op: string; input: unknown }): void;
  /** Runs once the outermost transaction commits (side effects such as launching a runner). */
  afterCommit(fn: () => void | Promise<void>): void;
}

type HandlerResult<N extends AnyOpName> = HandlerOutput<N> | RequiresHuman;

export interface OpHandler<N extends AnyOpName = AnyOpName> {
  /** Optional async phase before the transaction (network only). Must not write. */
  prepare?(input: HandlerInput<N>, p: PrepareContext): Promise<unknown>;
  /** Inside the op's transaction. Throw OpError to fail and roll back. */
  run(input: HandlerInput<N>, h: HandlerContext, prepared: unknown): HandlerResult<N> | Promise<HandlerResult<N>>;
  /** The handler applies the confidence x impact policy itself (per item); the runtime gate is skipped. */
  selfGated?: boolean;
  /** Decision kind when the runtime gates this op. */
  decisionKind?: DecisionKind;
  /** Subject for the gate decision. */
  subject?(input: HandlerInput<N>): { type: SubjectType; id: string };
}

export function defineHandler<N extends AnyOpName>(_name: N, handler: OpHandler<N>): OpHandler<N> {
  return handler;
}

export type HandlerMap = { [N in AnyOpName]?: OpHandler<N> };

export interface EngineDeps {
  db: Database.Database;
  /** PP_HOME (the vault root). */
  home: string;
  handlers?: HandlerMap;
  services?: EngineServices;
}

export interface Engine {
  runOp: RunOp;
  register<N extends AnyOpName>(name: N, handler: OpHandler<N>): void;
  has(name: string): boolean;
  readonly db: Database.Database;
  readonly home: string;
  readonly services: EngineServices;
}

interface Frame {
  vault: VaultTx;
  after: Array<() => void | Promise<void>>;
}

const err = (code: Extract<OpOutcome<unknown>, { status: 'error' }>['code'], message: string, issues?: unknown): OpOutcome<never> =>
  issues === undefined ? { status: 'error', code, message } : { status: 'error', code, message, issues };

function toOutcomeError(e: unknown): OpOutcome<never> {
  if (e instanceof OpError) return err(e.code, e.message, e.issues);
  // A thrown non-Error is not echoed back: it can carry a stack or anything else (#152).
  return err('internal', e instanceof Error ? e.message : 'unexpected error');
}

function defaultSubject(input: unknown): { type: SubjectType; id: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.role_id === 'string') return { type: 'role', id: i.role_id };
  if (typeof i.outreach_id === 'string') return { type: 'outreach', id: i.outreach_id };
  if (typeof i.diff_id === 'string') return { type: 'profile_diff', id: i.diff_id };
  if (typeof i.company_id === 'string') return { type: 'company', id: i.company_id };
  return { type: 'system', id: 'system' };
}

export function createEngine(deps: EngineDeps): Engine {
  const { db, home } = deps;
  const services = deps.services ?? {};
  const handlers = new Map<string, OpHandler>(Object.entries(deps.handlers ?? {}) as [string, OpHandler][]);
  const frames = new AsyncLocalStorage<Frame>();
  let lock: Promise<void> = Promise.resolve();
  let savepoints = 0;

  /** A decision authorizes a gated op if it is live and its action (or its undo) is this op. */
  function decisionAuthorizes(decisionId: string, name: string): boolean {
    const d = get(db, 'decision', decisionId);
    if (!d || ['rejected', 'undone', 'expired'].includes(d.status)) return false;
    const a = d.action_json as DecisionAction | null;
    return a?.op === name || a?.undo?.op === name;
  }

  function makeResolver(ctx: OpContext, config: PolicyConfig): ResolverInstance {
    const agentAttached = ctx.actor === 'agent';
    const backends = {
      ...backendsFromConfig(config, {
        ...(services.env ? { env: services.env } : {}),
        now: ctx.now,
        ...(agentAttached ? { agent: ctx.confidence ? { confidence: { p: ctx.confidence.p } } : {} } : {}),
      }),
      ...(services.backends ?? {}),
    };
    // The agent backend is the calling session: only present when an agent is attached.
    if (!agentAttached) delete backends.agent;
    const base = createDecisionStore(db);
    // #103: a decision made inside a skill run links to it (its decision_made carries run_id), so Now can group by run.
    const store = ctx.runId
      ? {
          ...base,
          appendEvent: (e: Parameters<typeof base.appendEvent>[0]) =>
            base.appendEvent(
              e.payload_json && typeof e.payload_json === 'object' && !Array.isArray(e.payload_json) && !('run_id' in e.payload_json)
                ? { ...e, payload_json: { ...e.payload_json, run_id: ctx.runId } }
                : e,
            ),
        }
      : base;
    return createResolver({
      config,
      backends,
      store,
      now: ctx.now,
      newId: () => newId('decision', ctx.now()),
      hardHuman: (r) => hardHumanHint(db, r),
    });
  }

  function uniqueRunLogPath(vault: VaultTx, date: string, op: string): string {
    const base = slugify(op) || 'run';
    const taken = (p: string) => vault.exists(p) || select(db, 'run', 'log_path = ?', [p]).length > 0;
    let path = vaultPath.runLog(date, base);
    for (let n = 2; taken(path); n++) path = vaultPath.runLog(date, `${base}-${n}`);
    return path;
  }

  /** Serialize top-level writes: one transaction at a time on this connection. */
  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lock;
    let release!: () => void;
    lock = new Promise<void>((r) => {
      release = r;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async function execute(
    name: AnyOpName,
    def: OpDef,
    handler: OpHandler,
    data: unknown,
    ctx: OpContext,
    config: PolicyConfig,
    prepared: unknown,
    frame: Frame,
  ): Promise<OpOutcome<unknown>> {
    const resolver = makeResolver(ctx, config);
    const human = ctx.actor === 'human';
    const subject = handler.subject ? handler.subject(data as never) : defaultSubject(data);
    const kind = handler.decisionKind ?? 'other';
    const approve = (forceHuman: boolean, impact = def.impact) =>
      resolver.record(
        {
          decision: kind,
          impact,
          subject,
          question: { id: 'approve', type: 'noulli', instructions: `Run ${name}?`, op: name, actor: ctx.actor },
          answer: { id: 'approve', value: true, p: ctx.confidence?.p ?? 0.5 },
          backend: ctx.confidence?.backend ?? 'agent',
          action: { op: name, input: data },
        },
        { forceHuman, actor: ctx.actor },
      );

    // ---- gate ---------------------------------------------------------------
    if (!human && (def.humanOnly || isHardHuman({ ...(handler.decisionKind ? { kind: handler.decisionKind } : {}), op: name }))) {
      const r = await approve(true, 'high');
      return { status: 'requires_human', decisionId: ctx.dryRun ? '' : r.decisionId };
    }
    const authorized = Boolean(ctx.decisionId && decisionAuthorizes(ctx.decisionId, name));
    const needsGate = !def.readOnly && !def.dynamicImpact && !handler.selfGated && def.impact !== 'low' && !human && !authorized;
    let gate: { decisionId: string; outcome: string } | null = null;
    if (needsGate) {
      // wave1-decisions #17: no confidence attached = Needs you.
      const r = await approve(!ctx.confidence);
      if (r.outcome === 'human') return { status: 'requires_human', decisionId: ctx.dryRun ? '' : r.decisionId };
      gate = { decisionId: r.decisionId, outcome: r.outcome };
      ctx = { ...ctx, decisionId: r.decisionId };
    }

    // ---- run ------------------------------------------------------------------
    const eventIds: string[] = [];
    const runLogs: RunLogEntry[] = [];
    let undo: { op: string; input: unknown } | null = null;
    const runCtx = ctx;
    const h: HandlerContext = {
      db,
      ctx: runCtx,
      config,
      home,
      services,
      name,
      def,
      repos: repos(db),
      vault: frame.vault,
      resolver,
      runOp,
      nowIso: () => runCtx.now().toISOString(),
      canEmit: (type) => def.emits.includes(type),
      emit(type, subjectType, subjectId, payload = {}, decisionId) {
        if (!def.emits.includes(type)) throw new OpError('internal', `${name} may not emit ${type}`);
        const id = newId('event', runCtx.now());
        insert(db, 'event', {
          id,
          ts: runCtx.now().toISOString(),
          type,
          subject_type: subjectType,
          subject_id: subjectId,
          // #50: an op inside a skill run (ctx.runId, e.g. a headless run's MCP server) links its events to the run.
          payload_json: runCtx.runId && payload.run_id === undefined ? { ...payload, run_id: runCtx.runId } : payload,
          actor: runCtx.actor,
          decision_id: decisionId === undefined ? (runCtx.decisionId ?? null) : decisionId,
        });
        eventIds.push(id);
        return id;
      },
      runLog: (entry) => runLogs.push(entry),
      setUndo: (call) => {
        undo = call;
      },
      afterCommit: (fn) => frame.after.push(fn),
    };

    const r = await handler.run(data as never, h, prepared);
    if (isRequiresHuman(r)) return { status: 'requires_human', decisionId: ctx.dryRun ? '' : r.decisionId };
    const out = def.output.safeParse(r);
    if (!out.success) throw new OpError('internal', `${name} output does not match the contract`, out.error.issues);

    // run logs
    const iso = ctx.now().toISOString();
    for (const entry of runLogs) {
      const section = `\n## ${entry.title}\n\n${entry.lines.join('\n')}\n`;
      const run = ctx.runId ? get(db, 'run', ctx.runId) : null;
      if (ctx.runId && !run) throw new OpError('not_found', `run not found: ${ctx.runId}`);
      if (run) {
        update(db, 'run', run.id, { summary_json: { ...run.summary_json, [name]: entry.summary } });
        if (run.log_path) frame.vault.append(run.log_path, section);
        continue;
      }
      const id = newId('run', ctx.now());
      const log_path = uniqueRunLogPath(frame.vault, iso.slice(0, 10), name);
      insert(db, 'run', { id, op: name, started_at: iso, finished_at: iso, status: 'ok', summary_json: entry.summary, log_path });
      frame.vault.write(log_path, renderMarkdown({ id, type: 'run' }, `# ${iso.slice(0, 10)} ${name}\n${section}`));
    }

    // auto + undo through the gate: record the inverse op on the decision.
    const undoCall = undo as { op: string; input: unknown } | null;
    if (gate?.outcome === 'auto_undo' && undoCall) {
      const d = get(db, 'decision', gate.decisionId);
      if (d?.action_json) update(db, 'decision', d.id, { action_json: { ...d.action_json, undo: undoCall } });
    }
    return { status: 'ok', output: out.data, eventIds };
  }

  const runOp: RunOp = async (name, input, ctx) => {
    const def = (ALL_OPS as Record<string, OpDef>)[name];
    if (!def) return err('not_found', `unknown op: ${name}`);
    if (def.unimplemented) return err('unimplemented', `${name} is not implemented in v2: ${def.description}`);
    const handler = handlers.get(name);
    if (!handler) return err('unimplemented', `${name} has no handler registered`);

    const parsed = def.input.safeParse(input);
    if (!parsed.success) return err('invalid_input', `invalid input for ${name}`, parsed.error.issues);
    const data = parsed.data;

    let config: PolicyConfig;
    try {
      config = readConfig(home);
    } catch (e) {
      return err('internal', `config.json is invalid: ${(e as Error).message}`);
    }

    let prepared: unknown;
    try {
      prepared = handler.prepare ? await handler.prepare(data as never, { db, ctx, config, home, services }) : undefined;
    } catch (e) {
      return toOutcomeError(e);
    }

    const parent = frames.getStore();
    const op = name as AnyOpName;
    const run = (frame: Frame) => frames.run(frame, () => execute(op, def, handler, data, ctx, config, prepared, frame));

    // Reads: no transaction, no lock.
    if (def.readOnly) {
      try {
        return await run({ vault: new VaultTx(home, parent?.vault), after: [] });
      } catch (e) {
        return toOutcomeError(e);
      }
    }

    // Nested write: a savepoint inside the parent's transaction.
    if (parent) {
      const sp = `pp_op_${++savepoints}`;
      const frame: Frame = { vault: new VaultTx(home, parent.vault), after: [] };
      db.exec(`SAVEPOINT ${sp}`);
      let outcome: OpOutcome<unknown>;
      try {
        outcome = await run(frame);
      } catch (e) {
        outcome = toOutcomeError(e);
      }
      const keep = outcome.status !== 'error' && !ctx.dryRun;
      if (!keep) db.exec(`ROLLBACK TO ${sp}`);
      db.exec(`RELEASE ${sp}`);
      if (keep) {
        frame.vault.mergeIntoParent();
        parent.after.push(...frame.after);
      }
      return outcome.status === 'ok' && ctx.dryRun ? { ...outcome, eventIds: [] } : outcome;
    }

    // Top-level write: one transaction, serialized. After-commit hooks run once the lock is released.
    const done = await withLock(async (): Promise<{ outcome: OpOutcome<unknown>; after: Frame['after'] }> => {
      const frame: Frame = { vault: new VaultTx(home), after: [] };
      db.exec('BEGIN IMMEDIATE');
      let outcome: OpOutcome<unknown>;
      try {
        outcome = await run(frame);
      } catch (e) {
        outcome = toOutcomeError(e);
      }
      if (outcome.status === 'error' || ctx.dryRun) {
        if (db.inTransaction) db.exec('ROLLBACK');
        frame.vault.discard();
        return { outcome: outcome.status === 'ok' ? { ...outcome, eventIds: [] } : outcome, after: [] };
      }
      db.exec('COMMIT');
      try {
        frame.vault.flush();
      } catch (e) {
        return { outcome: err('internal', `db committed but a vault write failed: ${(e as Error).message}`), after: [] };
      }
      return { outcome, after: frame.after };
    });
    for (const fn of done.after) {
      try {
        await fn();
      } catch {
        // after-commit side effects report their own failures (a runner that cannot start finishes its run as error)
      }
    }
    return done.outcome;
  };

  return {
    runOp,
    db,
    home,
    services,
    has: (name) => handlers.has(name),
    register(name, handler) {
      handlers.set(name, handler as unknown as OpHandler);
    },
  };
}
