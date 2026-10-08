import type { OpContext, OpOutcome, Skill } from '@perfect-placement/contracts';
import type { ops } from '@perfect-placement/engine';
import type { Args } from '../args.js';
import { actorOf, CliError, exitCodeOf, type Io, listInput, readJsonInput, show } from '../io.js';

type Engine = ops.Engine;

/**
 * Wrap op calls in a skill run: runs.start -> ops (ctx.runId) -> runs.finish.
 * The run log in `$PP_HOME/runs/` is the v1 coverage log.
 */
async function inRun(
  engine: Engine,
  skill: Skill,
  args: Args,
  io: Io,
  body: (ctx: OpContext) => Promise<OpOutcome<unknown>[]>,
): Promise<number> {
  const actor = actorOf(args, 'agent');
  const base: OpContext = { actor, now: () => new Date() };
  const started = await engine.runOp('runs.start', { skill }, base);
  if (started.status !== 'ok') {
    show(io, started);
    return 1;
  }
  const runId = (started.output as { run: { id: string } }).run.id;
  const ctx: OpContext = { ...base, runId, ...(args.has('dry-run') ? { dryRun: true } : {}) };
  let outcomes: OpOutcome<unknown>[] = [];
  let failure: string | null = null;
  try {
    outcomes = await body(ctx);
  } catch (e) {
    failure = (e as Error).message;
  }
  const errors = outcomes.filter((o) => o.status === 'error').length;
  const status = failure || (errors && errors === outcomes.length) ? 'error' : errors ? 'partial' : 'ok';
  const note = [args.get('note'), failure].filter(Boolean).join('\n\n');
  await engine.runOp('runs.finish', { run_id: runId, status, ...(note ? { note } : {}) }, base);
  if (failure) throw new CliError(failure);
  show(io, outcomes.length === 1 ? outcomes[0] : outcomes);
  return outcomes.some((o) => exitCodeOf(o) !== 0) ? 1 : 0;
}

/** `pp scout --in candidates.json [--note "queries run"]` -> roles.add */
export function scout(engine: Engine, args: Args, io: Io): Promise<number> {
  const candidates = listInput(readJsonInput(args, io), 'candidates');
  return inRun(engine, 'scout', args, io, async (ctx) => [await engine.runOp('roles.add', { candidates }, ctx)]);
}

/** `pp score --in scores.json` -> roles.score per role (lane F). */
export function score(engine: Engine, args: Args, io: Io): Promise<number> {
  const items = listInput(readJsonInput(args, io), 'scores');
  return inRun(engine, 'score', args, io, async (ctx) => {
    const out: OpOutcome<unknown>[] = [];
    for (const item of items) out.push(await engine.runOp('roles.score', item, ctx));
    return out;
  });
}

/** `pp fresh [--role <id>]... [--all]` -> roles.check_freshness (lane G). */
export function fresh(engine: Engine, args: Args, io: Io): Promise<number> {
  const role_ids = args.all('role');
  const input = role_ids.length ? { role_ids } : { all_in_scope: true };
  return inRun(engine, 'freshness', args, io, async (ctx) => [await engine.runOp('roles.check_freshness', input, ctx)]);
}

/** `pp inbox --in messages.json` -> inbox.ingest */
export function inbox(engine: Engine, args: Args, io: Io): Promise<number> {
  const messages = listInput(readJsonInput(args, io), 'messages');
  return inRun(engine, 'inbox', args, io, async (ctx) => [await engine.runOp('inbox.ingest', { messages }, ctx)]);
}

/** `pp op <name> [--input '<json>' | --in file] [--actor human]` -> any op. */
export async function op(engine: Engine, args: Args, io: Io): Promise<number> {
  const name = args._[1];
  if (!name) throw new CliError('usage: pp op <name> [--input <json> | --in <file|->] [--actor agent|human|schedule]');
  let input: unknown = {};
  const inline = args.get('input');
  if (inline) {
    try {
      input = JSON.parse(inline);
    } catch (e) {
      throw new CliError(`--input is not valid JSON: ${(e as Error).message}`);
    }
  } else if (args.has('in')) input = readJsonInput(args, io);
  const ctx: OpContext = {
    actor: actorOf(args, 'agent'),
    now: () => new Date(),
    ...(args.get('run') ? { runId: args.get('run') as string } : {}),
    ...(args.get('decision') ? { decisionId: args.get('decision') as string } : {}),
    ...(args.has('dry-run') ? { dryRun: true } : {}),
  };
  const outcome = await engine.runOp(name, input, ctx);
  show(io, outcome);
  return exitCodeOf(outcome);
}
