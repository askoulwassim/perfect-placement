import {
  type DecisionKind,
  type EventType,
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
import type Database from 'better-sqlite3';
import type { z } from 'zod';
import { shimDecisions } from './_shim/decisions.js';
import { EXTRA_OPS, type ExtraOpName } from './_shim/extra-ops.js';
import { get, insert, select, update } from './_shim/repo.js';
import { OpError } from './errors.js';
import { newId, slugify } from './ids.js';
import type { DecisionPort } from './ports.js';
import { readConfig, renderMarkdown, VaultTx } from './vault.js';

/*
 * The single entry point: `runOp(name, input, ctx)`.
 * 1. look up the op (contracts registry + lane B extras), refuse unimplemented ones
 * 2. validate input with zod
 * 3. gate: human-only ops and medium/high ops from automated actors become a queued
 *    decision (requires_human) unless the handler applies policy per item itself
 * 4. run the handler inside one db transaction; vault writes flush after commit
 * 5. validate the output against the contract, return the event ids it wrote
 */

export type AnyOpName = OpName | ExtraOpName;
type AllOps = typeof OPS & typeof EXTRA_OPS;
export type HandlerInput<N extends AnyOpName> = z.output<AllOps[N]['input']>;
export type HandlerOutput<N extends AnyOpName> = z.input<AllOps[N]['output']>;

export const ALL_OPS: Record<AnyOpName, OpDef> = { ...OPS, ...EXTRA_OPS };

const REQUIRES_HUMAN = Symbol('requires_human');
export interface RequiresHuman {
  [REQUIRES_HUMAN]: true;
  decisionId: string;
}
export const requiresHuman = (decisionId: string): RequiresHuman => ({ [REQUIRES_HUMAN]: true, decisionId });
const isRequiresHuman = (v: unknown): v is RequiresHuman => typeof v === 'object' && v !== null && REQUIRES_HUMAN in v;

export interface RunLogEntry {
  title: string;
  lines: string[];
  summary: Record<string, unknown>;
}

/** Read-only context for the async `prepare` phase (network, resolver calls). */
export interface PrepareContext {
  db: Database.Database;
  ctx: OpContext;
  config: PolicyConfig;
  home: string;
}

/** What a handler gets inside the transaction. */
export interface HandlerContext extends PrepareContext {
  name: AnyOpName;
  def: OpDef;
  vault: VaultTx;
  decisions: DecisionPort;
  nowIso(): string;
  /** Write one event row. `type` must be in the op's `emits`. */
  emit(type: EventType, subjectType: SubjectType, subjectId: string, payload?: Record<string, unknown>, decisionId?: string | null): string;
  /** Can this op emit `type`? (Used for fallbacks while emits lists are frozen.) */
  canEmit(type: EventType): boolean;
  /** Record a run log: appended to ctx.runId's log, or a new finished run for this op. */
  runLog(entry: RunLogEntry): void;
}

export interface OpHandler<N extends AnyOpName = AnyOpName> {
  /** Optional async phase before the transaction (I/O, resolver.ask). Must not write. */
  prepare?(input: HandlerInput<N>, p: PrepareContext): Promise<unknown>;
  /** Synchronous, inside one transaction. Throw OpError to fail and roll back. */
  run(input: HandlerInput<N>, h: HandlerContext, prepared: unknown): HandlerOutput<N> | RequiresHuman;
  /** The handler applies the confidence x impact policy itself (per item); the runtime gate is skipped. */
  selfGated?: boolean;
  /** Decision kind when the runtime queues this op for a human. */
  decisionKind?: DecisionKind;
  /** Subject for the queued decision. */
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
  /** Defaults to the lane I shim. */
  decisions?: DecisionPort;
  handlers?: HandlerMap;
}

export interface Engine {
  runOp: RunOp;
  register<N extends AnyOpName>(name: N, handler: OpHandler<N>): void;
  has(name: string): boolean;
  readonly db: Database.Database;
  readonly home: string;
}

const DRY_RUN = Symbol('dry_run');

const err = (code: Extract<OpOutcome<unknown>, { status: 'error' }>['code'], message: string, issues?: unknown): OpOutcome<never> =>
  issues === undefined ? { status: 'error', code, message } : { status: 'error', code, message, issues };

function defaultSubject(input: unknown): { type: SubjectType; id: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  if (typeof i.role_id === 'string') return { type: 'role', id: i.role_id };
  if (typeof i.outreach_id === 'string') return { type: 'outreach', id: i.outreach_id };
  if (typeof i.company_id === 'string') return { type: 'company', id: i.company_id };
  return { type: 'system', id: 'system' };
}

export function createEngine(deps: EngineDeps): Engine {
  const { db, home } = deps;
  const decisions = deps.decisions ?? shimDecisions;
  const handlers = new Map<string, OpHandler>(Object.entries(deps.handlers ?? {}) as [string, OpHandler][]);

  /** A decision id authorizes a gated op if it exists, is not dead, and its action is this op. */
  function decisionAuthorizes(decisionId: string, name: string): boolean {
    const d = get(db, 'decision', decisionId);
    if (!d || ['rejected', 'undone', 'expired'].includes(d.status)) return false;
    return (d.action_json as { op?: string } | null)?.op === name;
  }

  function uniqueRunLogPath(vault: VaultTx, date: string, op: string): string {
    const base = slugify(op) || 'run';
    const taken = (p: string) => vault.exists(p) || select(db, 'run', 'log_path = ?', [p]).length > 0;
    let path = vaultPath.runLog(date, base);
    for (let n = 2; taken(path); n++) path = vaultPath.runLog(date, `${base}-${n}`);
    return path;
  }

  const runOp: RunOp = async (name, input, ctx) => {
    const def = (ALL_OPS as Record<string, OpDef>)[name];
    if (!def) return err('not_found', `unknown op: ${name}`);
    if (def.unimplemented) return err('unimplemented', `${name} is not implemented in v2: ${def.description}`);
    const handler = handlers.get(name);
    if (!handler) return err('unimplemented', `${name} is owned by lane ${def.owner}, not merged yet`);

    const parsed = def.input.safeParse(input);
    if (!parsed.success) return err('invalid_input', `invalid input for ${name}`, parsed.error.issues);
    const data = parsed.data;

    let config: PolicyConfig;
    try {
      config = readConfig(home);
    } catch (e) {
      return err('internal', `config.json is invalid: ${(e as Error).message}`);
    }

    // ---- gate ---------------------------------------------------------------
    const human = ctx.actor === 'human';
    const needsGate = def.humanOnly
      ? !human
      : !def.readOnly &&
        !def.dynamicImpact &&
        !handler.selfGated &&
        def.impact !== 'low' &&
        !human &&
        !(ctx.decisionId && decisionAuthorizes(ctx.decisionId, name));
    if (needsGate) {
      const queue = db.transaction(() =>
        decisions.record(
          db,
          {
            kind: handler.decisionKind ?? 'other',
            impact: def.impact,
            subject: handler.subject ? handler.subject(data as never) : defaultSubject(data),
            question: { id: 'approve', type: 'noulli', instructions: `Run ${name}?`, op: name, actor: ctx.actor },
            answer: { id: 'approve', value: true, p: 0.5 },
            backend: 'llm',
            action: { op: name, input: data },
            forceHuman: true,
          },
          { ctx, config },
        ),
      );
      if (ctx.dryRun) return { status: 'requires_human', decisionId: '' };
      return { status: 'requires_human', decisionId: queue().decisionId };
    }

    // ---- prepare (async, no writes) ----------------------------------------
    const pctx: PrepareContext = { db, ctx, config, home };
    let prepared: unknown;
    try {
      prepared = handler.prepare ? await handler.prepare(data as never, pctx) : undefined;
    } catch (e) {
      return e instanceof OpError ? err(e.code, e.message, e.issues) : err('internal', (e as Error).message);
    }

    // ---- run (one transaction) ---------------------------------------------
    const vault = new VaultTx(home);
    const eventIds: string[] = [];
    const runLogs: RunLogEntry[] = [];
    const h: HandlerContext = {
      ...pctx,
      name: name as AnyOpName,
      def,
      vault,
      decisions,
      nowIso: () => ctx.now().toISOString(),
      canEmit: (type) => def.emits.includes(type),
      emit(type, subjectType, subjectId, payload = {}, decisionId) {
        if (!def.emits.includes(type)) throw new OpError('internal', `${name} may not emit ${type}`);
        const id = newId('event', ctx.now());
        insert(db, 'event', {
          id,
          ts: ctx.now().toISOString(),
          type,
          subject_type: subjectType,
          subject_id: subjectId,
          payload_json: payload,
          actor: ctx.actor,
          decision_id: decisionId === undefined ? (ctx.decisionId ?? null) : decisionId,
        });
        eventIds.push(id);
        return id;
      },
      runLog: (entry) => runLogs.push(entry),
    };

    function writeRunLogs() {
      const now = ctx.now();
      const iso = now.toISOString();
      for (const entry of runLogs) {
        const section = `\n## ${entry.title}\n\n${entry.lines.join('\n')}\n`;
        const run = ctx.runId ? get(db, 'run', ctx.runId) : null;
        if (ctx.runId && !run) throw new OpError('not_found', `run not found: ${ctx.runId}`);
        if (run) {
          update(db, 'run', run.id, { summary_json: { ...run.summary_json, [name]: entry.summary } });
          if (run.log_path) vault.append(run.log_path, section);
          continue;
        }
        const id = newId('run', now);
        const log_path = uniqueRunLogPath(vault, iso.slice(0, 10), name);
        insert(db, 'run', { id, op: name, started_at: iso, finished_at: iso, status: 'ok', summary_json: entry.summary, log_path });
        vault.write(log_path, renderMarkdown({ id, type: 'run' }, `# ${iso.slice(0, 10)} ${name}\n${section}`));
      }
    }

    let result: { kind: 'ok'; output: unknown } | { kind: 'human'; decisionId: string } | undefined;
    try {
      db.transaction(() => {
        const r = handler.run(data as never, h, prepared);
        if (isRequiresHuman(r)) result = { kind: 'human', decisionId: r.decisionId };
        else {
          const out = def.output.safeParse(r);
          if (!out.success) throw new OpError('internal', `${name} output does not match the contract`, out.error.issues);
          writeRunLogs();
          result = { kind: 'ok', output: out.data };
        }
        if (ctx.dryRun) throw DRY_RUN;
      })();
    } catch (e) {
      vault.discard();
      if (e !== DRY_RUN) {
        if (e instanceof OpError) return err(e.code, e.message, e.issues);
        return err('internal', (e as Error).message);
      }
      if (result?.kind === 'human') return { status: 'requires_human', decisionId: '' };
      return { status: 'ok', output: result?.output, eventIds: [] };
    }
    try {
      vault.flush();
    } catch (e) {
      return err('internal', `db committed but a vault write failed: ${(e as Error).message}`);
    }
    if (!result) return err('internal', `${name} returned nothing`);
    if (result.kind === 'human') return { status: 'requires_human', decisionId: result.decisionId };
    return { status: 'ok', output: result.output, eventIds };
  };

  return {
    runOp,
    db,
    home,
    has: (name) => handlers.has(name),
    register(name, handler) {
      handlers.set(name, handler as unknown as OpHandler);
    },
  };
}
