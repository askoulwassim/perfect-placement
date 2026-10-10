import {
  type OpContext,
  type PolicyConfig,
  RUN_ACTIVE_STATUSES,
  type Run,
  type RunOp,
  SCHEDULE_KEYS,
  SCHEDULE_SKILL,
  type ScheduleKey,
  scheduleMissed,
} from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { summaryOf } from './queue.js';
import { isTransient, SCHEDULE_RETRY } from './retry.js';
import { select } from './rows.js';

/*
 * Schedules (#29), engine side: which run a schedule last started (`summary_json.schedule`), and the
 * `pp up` catch-up. The OS jobs themselves (launchd, systemd) live in the CLI.
 */

/** The latest run started for schedule `key` (any status), or null. */
export function lastScheduledRun(db: Database.Database, key: ScheduleKey): Run | null {
  return select(db, 'run', `json_extract(summary_json, '$.schedule') = ? ORDER BY started_at DESC, id DESC LIMIT 1`, [key])[0] ?? null;
}

/**
 * #121: the last run of a schedule failed for good: `error`, transient (`SCHEDULE_RETRY`), and its retries are spent
 * (no retry queued). The catch-up queues it again.
 */
export function failedForGood(run: Run): boolean {
  const s = summaryOf(run);
  return run.status === 'error' && !s.retried && isTransient({ code: s.error_code, message: s.error }, SCHEDULE_RETRY);
}

/**
 * `pp up` catch-up: every schedule that is on, ran before, and has fired since its last run started
 * (`scheduleMissed`), or whose last run failed transiently after all its retries (#121, `failedForGood`), is
 * queued once with actor `schedule`. A schedule whose last run is still queued or running is left alone.
 * Returns the run ids it queued.
 */
export async function catchUpSchedules(
  db: Database.Database,
  runOp: RunOp,
  config: PolicyConfig,
  now: () => Date,
): Promise<{ key: ScheduleKey; run_id: string }[]> {
  const out: { key: ScheduleKey; run_id: string }[] = [];
  const ctx: OpContext = { actor: 'schedule', now };
  for (const key of SCHEDULE_KEYS) {
    const spec = config.schedules[key];
    if (spec === 'off') continue;
    const last = lastScheduledRun(db, key);
    if (!last || (RUN_ACTIVE_STATUSES as readonly string[]).includes(last.status)) continue;
    if (!failedForGood(last) && !scheduleMissed(spec, last.started_at, now())) continue;
    const o = await runOp('runs.start', { skill: SCHEDULE_SKILL[key], schedule: key }, ctx);
    if (o.status === 'ok') out.push({ key, run_id: (o.output as { run: Run }).run.id });
  }
  return out;
}
