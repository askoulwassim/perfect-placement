import { z } from 'zod';
import type { Skill } from './enums.js';

/*
 * Schedules (#29): `config.schedules` maps each schedule to a spec. Specs are local wall-clock times
 * (the OS job fires in the machine's time zone):
 *   `daily HH:MM`        every day
 *   `weekdays HH:MM`     Monday to Friday
 *   `fri HH:MM`          one day; `mon,thu HH:MM` several (sun mon tue wed thu fri sat)
 *   `off`                no job
 * Pure helpers only: the OS jobs live in the CLI (`pp schedules`), the catch-up in `pp up`.
 */

export const SCHEDULE_KEYS = ['inbox', 'freshness', 'scout_score'] as const;
export const ScheduleKey = z.enum(SCHEDULE_KEYS);
export type ScheduleKey = z.infer<typeof ScheduleKey>;

/** The skill a schedule enqueues. `scout_score` enqueues scout; the pipeline (#30) queues score and research. */
export const SCHEDULE_SKILL: Readonly<Record<ScheduleKey, Skill>> = { inbox: 'inbox', freshness: 'freshness', scout_score: 'scout' };

/** The schedule that enqueues `skill`, if any. */
export function scheduleForSkill(skill: string): ScheduleKey | null {
  return SCHEDULE_KEYS.find((k) => SCHEDULE_SKILL[k] === skill) ?? null;
}

/**
 * The OS job behind a schedule, as `pp schedules status`, `schedules.status` and `pp doctor` see it:
 * `installed` matches config; `missing` on in config, no job; `stale` a job for another spec, vault or
 * node; `off` off in config and no job; `orphan` off in config but a job is left; `manual` no job
 * manager here (crontab lines printed); `unknown` this process cannot see the OS (no scheduler wired).
 */
export const SCHEDULE_JOB_STATES = ['installed', 'missing', 'stale', 'off', 'orphan', 'manual', 'unknown'] as const;
export const ScheduleJobState = z.enum(SCHEDULE_JOB_STATES);
export type ScheduleJobState = z.infer<typeof ScheduleJobState>;

export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export interface ParsedSchedule {
  /** Days it fires, 0 = Sunday, ascending. */
  days: number[];
  hour: number;
  minute: number;
  /** Every day (`daily`). */
  daily: boolean;
}

/** Parse a spec; `null` for `off` or anything unparseable. */
export function parseSchedule(spec: string): ParsedSchedule | null {
  const m = /^([a-z,]+)\s+(\d{1,2}):(\d{2})$/.exec(spec.trim().toLowerCase());
  if (!m) return null;
  const [, when, hh, mm] = m as unknown as [string, string, string, string];
  const hour = Number(hh);
  const minute = Number(mm);
  if (hour > 23 || minute > 59) return null;
  if (when === 'daily') return { days: [0, 1, 2, 3, 4, 5, 6], hour, minute, daily: true };
  if (when === 'weekdays') return { days: [1, 2, 3, 4, 5], hour, minute, daily: false };
  const days = new Set<number>();
  for (const d of when.split(',')) {
    const i = (DAY_NAMES as readonly string[]).indexOf(d);
    if (i < 0) return null;
    days.add(i);
  }
  return { days: [...days].sort((a, b) => a - b), hour, minute, daily: days.size === 7 };
}

const at = (base: Date, addDays: number, p: ParsedSchedule): Date =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + addDays, p.hour, p.minute, 0, 0);

/** The next local fire time strictly after `from`, or null (off / unparseable). */
export function nextFire(spec: string, from: Date): Date | null {
  const p = parseSchedule(spec);
  if (!p) return null;
  for (let d = 0; d <= 7; d++) {
    const t = at(from, d, p);
    if (t > from && p.days.includes(t.getDay())) return t;
  }
  return null;
}

/** The latest local fire time at or before `now`, or null. */
export function prevFire(spec: string, now: Date): Date | null {
  const p = parseSchedule(spec);
  if (!p) return null;
  for (let d = 0; d <= 7; d++) {
    const t = at(now, -d, p);
    if (t <= now && p.days.includes(t.getDay())) return t;
  }
  return null;
}

/**
 * Catch-up rule for `pp up`: the schedule fired since its last run started (the machine was off or
 * asleep, or no OS job ran it). A schedule that never ran is not "missed": its first run comes from
 * the OS job (or a Run button).
 */
export function scheduleMissed(spec: string, lastStartedAt: string | null, now: Date): boolean {
  if (!lastStartedAt) return false;
  const prev = prevFire(spec, now);
  return prev !== null && new Date(lastStartedAt) < prev;
}
