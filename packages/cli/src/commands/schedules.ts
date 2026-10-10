/*
 * `pp schedules install|remove|status` and `pp run <skill> [--schedule]` (#29).
 * The OS jobs (system/schedules.ts) run `pp run <skill> --schedule`: enqueue through runs.start
 * (actor schedule, `schedule` set), then drain the queue until the run and the runs it triggered are done.
 */
import {
  RUN_ACTIVE_STATUSES,
  type Run,
  SCHEDULE_KEYS,
  SCHEDULE_SKILL,
  type ScheduleKey,
  type ScheduleStatus,
  Skill,
  scheduleForSkill,
} from '@perfect-placement/contracts';
import { type EngineServices, ops } from '@perfect-placement/engine';
import type { Args } from '../args.js';
import { CliError, type Io } from '../io.js';
import { jobManager, launchAgentsDir, removeJobs, scheduleJobsService, syncJobs, systemdUserDir } from '../system/schedules.js';
import { sysOf } from './kev.js';

/**
 * Engine services for a real vault with the OS job manager wired in (schedules.status, config.update
 * sync). Tests that inject `services` without `sys` get no job manager: nothing touches the machine.
 */
export function servicesWithJobs(io: Io, home: string): EngineServices {
  const base = io.services ?? {};
  if (io.services && !io.sys) return base;
  return { ...base, scheduleJobs: scheduleJobsService(home, sysOf(io)) };
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const two = (n: number) => String(n).padStart(2, '0');
/** Local time, e.g. "Fri 2026-10-09 07:30". */
export const localTime = (iso: string) => {
  const t = new Date(iso);
  return `${DAYS[t.getDay()]} ${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}`;
};

export async function schedulesCommand(args: Args, home: string, io: Io): Promise<number> {
  const sub = args._[1] ?? 'status';
  const d = sysOf(io);
  const where = () => {
    const m = jobManager(d);
    return m === 'launchd'
      ? `launchd (${launchAgentsDir(d)})`
      : m === 'systemd'
        ? `systemd user timers (${systemdUserDir(d)})`
        : 'cron (manual)';
  };
  if (sub === 'install') {
    const r = await syncJobs(home, ops.readConfig(home).schedules, d, { force: true });
    io.out(`pp schedules: ${where()}`);
    for (const l of r.lines) (r.ok ? io.out : io.err)(l);
    return r.ok ? 0 : 1;
  }
  if (sub === 'remove') {
    for (const l of removeJobs(d).lines) io.out(l);
    return 0;
  }
  if (sub !== 'status') throw new CliError('usage: pp schedules install|remove|status');
  const engine = ops.openEngine({ home, services: servicesWithJobs(io, home) });
  try {
    const o = await engine.runOp('schedules.status', {}, { actor: 'human', now: () => new Date() });
    if (o.status !== 'ok') throw new Error(o.status === 'error' ? o.message : 'requires a human');
    const items = (o.output as { items: ScheduleStatus[] }).items;
    if (args.has('json')) {
      io.out(JSON.stringify(items, null, 2));
      return 0;
    }
    io.out(`pp schedules: ${where()}`);
    for (const s of items) {
      const last = s.last_run ? `last ${s.last_run.status} ${localTime(s.last_run.started_at)}` : 'never ran';
      io.out(
        `  ${s.key.padEnd(12)} ${s.spec.padEnd(14)} ${s.next_run ? `next ${localTime(s.next_run)}` : 'off'.padEnd(25)}  ${last}  job ${s.job}`,
      );
    }
    return items.some((s) => s.job === 'missing' || s.job === 'stale' || s.job === 'orphan') ? 1 : 0;
  } finally {
    engine.close();
  }
}

/** How long `pp run` waits between queue drains, and how many times (default 15 s x 1440 = 6 h). */
export const RUN_POLL_MS = 15_000;
export const RUN_MAX_POLLS = 1440;

export type Drain = (engine: ops.Engine) => Promise<unknown>;

/**
 * `pp run <skill> [--schedule] [--role <id>]`: queue one skill run (actor `schedule` with --schedule,
 * else `human`), then drain the queue until it and the runs it triggered (the pipeline) are finished.
 * `<skill>` may also be a schedule key (`scout_score` = scout). Exit 0 when the run ended ok or partial.
 */
export async function runCommand(engine: ops.Engine, args: Args, io: Io, drain: Drain): Promise<number> {
  const raw = args._[1];
  if (!raw) throw new CliError('usage: pp run <skill> [--schedule] [--role <id>]');
  const asKey = (SCHEDULE_KEYS as readonly string[]).includes(raw) ? (raw as ScheduleKey) : null;
  const parsed = Skill.safeParse(asKey ? SCHEDULE_SKILL[asKey] : raw);
  if (!parsed.success) throw new CliError(`pp run: unknown skill "${raw}" (${Skill.options.join(', ')})`);
  const skill = parsed.data;
  const scheduled = args.has('schedule');
  const schedule = scheduled ? (asKey ?? scheduleForSkill(skill)) : null;
  if (scheduled && !schedule) throw new CliError(`pp run: ${skill} has no schedule (${SCHEDULE_KEYS.join(', ')})`);
  const role = args.get('role');
  const ctx = { actor: scheduled ? ('schedule' as const) : ('human' as const), now: () => new Date() };
  const o = await engine.runOp('runs.start', { skill, ...(role ? { role_id: role } : {}), ...(schedule ? { schedule } : {}) }, ctx);
  if (o.status !== 'ok') {
    io.err(`pp run: ${o.status === 'error' ? `${o.code}: ${o.message}` : 'requires a human'}`);
    return 1;
  }
  const started = o.output as { run: Run; deduped?: boolean };
  const root = started.run.id;
  io.out(`pp run: ${skill} run ${root} ${started.deduped ? 'already active' : 'queued'}${schedule ? ` (schedule ${schedule})` : ''}`);
  if (args.has('no-wait')) return 0;

  const sys = sysOf(io);
  const pending = new Set([root]);
  const done = new Map<string, Run>();
  let final = root;
  for (let i = 0; i < RUN_MAX_POLLS; i++) {
    await drain(engine);
    for (const id of [...pending]) {
      const g = await engine.runOp('runs.get', { run_id: id }, ctx);
      if (g.status !== 'ok') {
        pending.delete(id);
        continue;
      }
      const run = (g.output as { run: Run }).run;
      if ((RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status)) continue;
      pending.delete(id);
      done.set(id, run);
      const s = (run.summary_json ?? {}) as { error?: string; triggered?: string[]; retried?: string };
      io.out(`pp run: ${run.op} run ${id} ${run.status}${s.error ? `: ${s.error}` : ''}${s.retried ? ` (retry ${s.retried} queued)` : ''}`);
      for (const t of s.triggered ?? []) if (!done.has(t)) pending.add(t);
      // #122: a connector retry stands in for the run it retries: wait for it, and its outcome is the result.
      if (s.retried && !done.has(s.retried)) {
        pending.add(s.retried);
        if (final === id) final = s.retried;
      }
    }
    if (!pending.size) break;
    await sys.sleep(RUN_POLL_MS);
  }
  if (pending.size) {
    io.err(`pp run: still running after the wait: ${[...pending].join(', ')}`);
    return 1;
  }
  const status = done.get(final)?.status;
  return status === 'ok' || status === 'partial' ? 0 : 1;
}
