import { nextFire, SCHEDULE_KEYS, SCHEDULE_SKILL } from '@perfect-placement/contracts';
import { defineHandler } from '../runtime.js';
import { lastScheduledRun } from '../schedules.js';

/** schedules.status (#29): spec, next local fire time, last scheduled run, OS job state per schedule. */
export const schedulesStatus = defineHandler('schedules.status', {
  run(_input, h) {
    const schedules = h.config.schedules;
    let jobs: ReturnType<NonNullable<typeof h.services.scheduleJobs>['status']> | null = null;
    try {
      jobs = h.services.scheduleJobs?.status(schedules) ?? null;
    } catch {
      jobs = null;
    }
    const now = h.ctx.now();
    return {
      items: SCHEDULE_KEYS.map((key) => {
        const spec = schedules[key];
        const next = spec === 'off' ? null : nextFire(spec, now);
        return {
          key,
          skill: SCHEDULE_SKILL[key],
          spec,
          on: spec !== 'off',
          next_run: next ? next.toISOString() : null,
          last_run: lastScheduledRun(h.db, key),
          job: jobs?.[key] ?? 'unknown',
        };
      }),
    };
  },
});
