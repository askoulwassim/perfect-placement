import { CONFIG_FILE, PolicyConfig } from '@perfect-placement/contracts';
import { OpError } from '../errors.js';
import { defineHandler } from '../runtime.js';
import { deepMerge } from '../vault.js';

export const configGet = defineHandler('config.get', {
  run(_input, h) {
    return h.config;
  },
});

export const configUpdate = defineHandler('config.update', {
  decisionKind: 'other',
  subject: () => ({ type: 'system', id: 'config' }),
  run(input, h) {
    const merged = deepMerge(h.config as unknown as Record<string, unknown>, input.patch);
    const parsed = PolicyConfig.safeParse(merged);
    if (!parsed.success) throw new OpError('invalid_input', 'patched config does not parse as PolicyConfig', parsed.error.issues);
    h.vault.write(CONFIG_FILE, `${JSON.stringify(parsed.data, null, 2)}\n`);
    // Schedules changed (#29): bring the OS jobs in line once the config is on disk (installs the ones
    // on, removes the ones off). Only where the surface wired a job manager in (`pp up`).
    const jobs = h.services.scheduleJobs;
    if (jobs && !h.ctx.dryRun && JSON.stringify(h.config.schedules) !== JSON.stringify(parsed.data.schedules)) {
      const schedules = parsed.data.schedules;
      h.afterCommit(async () => {
        await jobs.sync(schedules);
      });
    }
    return parsed.data;
  },
});
