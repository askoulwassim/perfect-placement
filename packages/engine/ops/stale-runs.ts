import type { OpContext, Run, RunOp } from '@perfect-placement/contracts';
import { scheduleOf } from './queue.js';
import { stallLimitMs } from './retry.js';
import { killRunner, runnerAlive } from './runner.js';

/** `summary_json.error` of a run whose runner died without `runs.finish` while nothing was watching it. */
export const INTERRUPTED = 'interrupted';

export interface StaleRunOptions {
  /** Is this run's runner process still alive? Default: the spawn launcher's pid file. */
  isAlive?: (run: Run) => boolean;
  now?: () => Date;
  /** Runs younger than this are left alone (the launch may not have written its pid yet). Default 60 s. */
  graceMs?: number;
}

/**
 * Finish as `error` ("interrupted") every `running` run whose headless runner is gone: `pp up` calls it
 * on startup (a run left open by a previous process) and then periodically (a detached runner that
 * outlived the `pp up` that launched it). Only runs a launcher started are touched (`summary_json.runner`,
 * actor not `agent`): an agent session's own run, an in-process run and a `queued` run (#30) are not.
 * Writes go through `runs.finish`. Returns the ids finished.
 */
export async function interruptStaleRuns(runOp: RunOp, opts: StaleRunOptions = {}): Promise<string[]> {
  const now = opts.now ?? (() => new Date());
  const isAlive = opts.isAlive ?? ((r: Run) => runnerAlive(r.id));
  const grace = opts.graceMs ?? 60_000;
  const ctx: OpContext = { actor: 'schedule', now };
  const stale: Run[] = [];
  let cursor: string | null = null;
  do {
    const o = await runOp('runs.list', { limit: 200, ...(cursor ? { cursor } : {}) }, ctx);
    if (o.status !== 'ok') break;
    const page = o.output as { items: Run[]; next_cursor: string | null };
    for (const r of page.items) {
      const s = (r.summary_json ?? {}) as { runner?: unknown; actor?: unknown };
      if (r.status !== 'running' || !s.runner || s.actor === 'agent') continue;
      if (now().getTime() - Date.parse(r.started_at) < grace) continue;
      if (!isAlive(r)) stale.push(r);
    }
    cursor = page.next_cursor;
  } while (cursor);
  const done: string[] = [];
  for (const r of stale) {
    const o = await runOp(
      'runs.finish',
      {
        run_id: r.id,
        status: 'error',
        summary: { error: INTERRUPTED },
        note: 'Interrupted: the runner process is gone (pp up restarted, or the runner died) and the run was never finished.',
      },
      ctx,
    );
    if (o.status === 'ok') done.push(r.id);
  }
  return done;
}

export interface StallOptions {
  now?: () => Date;
  /** Kill the run's runner process tree. Default: the spawn launcher's pid file, SIGTERM to its process group. */
  kill?: (run: Run) => void;
  /** Cap per skill, ms (default `stallLimitMs`). */
  limitMs?: (skill: string) => number;
}

/**
 * #121: a scheduled run (`summary_json.schedule` or `schedule_origin`) still `running` past its skill's wall-clock cap
 * (from `launched_at`) has stalled, e.g. the Mac slept mid-run and the connector idled out: kill its runner's process
 * tree, then finish it `error_code: "stalled"` through `runs.finish`, which retries it under `SCHEDULE_RETRY`. `pp up`'s
 * sweep and `pp run`'s drain call it, so it works whichever process launched the runner. Returns the ids finished.
 */
export async function capStalledRuns(runOp: RunOp, opts: StallOptions = {}): Promise<string[]> {
  const now = opts.now ?? (() => new Date());
  const kill = opts.kill ?? ((r: Run) => void killRunner(r.id));
  const limit = opts.limitMs ?? stallLimitMs;
  const ctx: OpContext = { actor: 'schedule', now };
  const stalled: Array<{ run: Run; mins: number }> = [];
  let cursor: string | null = null;
  do {
    const o = await runOp('runs.list', { limit: 200, ...(cursor ? { cursor } : {}) }, ctx);
    if (o.status !== 'ok') break;
    const page = o.output as { items: Run[]; next_cursor: string | null };
    for (const r of page.items) {
      const s = (r.summary_json ?? {}) as { runner?: unknown; actor?: unknown; launched_at?: unknown };
      if (r.status !== 'running' || !s.runner || s.actor === 'agent' || !scheduleOf(r)) continue;
      const from = Date.parse(typeof s.launched_at === 'string' ? s.launched_at : r.started_at);
      const cap = limit(r.op);
      if (now().getTime() - from > cap) stalled.push({ run: r, mins: Math.round(cap / 60_000) });
    }
    cursor = page.next_cursor;
  } while (cursor);
  const done: string[] = [];
  for (const { run, mins } of stalled) {
    try {
      kill(run);
    } catch {
      // already gone: finish it anyway
    }
    const error = `stalled: ${run.op} ran past its ${mins} min cap`;
    const o = await runOp(
      'runs.finish',
      {
        run_id: run.id,
        status: 'error',
        error_code: 'stalled',
        error,
        note: `Stalled: no runs.finish within ${mins} min (the machine may have slept, or a connector hung). The runner was stopped.`,
      },
      ctx,
    );
    if (o.status === 'ok') done.push(run.id);
  }
  return done;
}
