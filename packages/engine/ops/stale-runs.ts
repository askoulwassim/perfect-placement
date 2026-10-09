import type { OpContext, Run, RunOp } from '@perfect-placement/contracts';
import { runnerAlive } from './runner.js';

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
