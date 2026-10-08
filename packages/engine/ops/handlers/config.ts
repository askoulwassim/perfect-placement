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
    return parsed.data;
  },
});
