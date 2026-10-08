import { readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { describe, expect, it } from 'vitest';
import { openFixtureDemo } from './engine.js';

describe('fixtures demo engine (pp-mcp --fixtures, pp up --fixtures)', () => {
  it('opens the real engine on a temp copy of the fixture vault, offline', async () => {
    const demo = await openFixtureDemo();
    try {
      expect(JSON.parse(readFileSync(join(demo.home, 'config.json'), 'utf8')).linkedin.mode).toBe('dry-run');
      const out = await demo.engine.runOp('roles.get', { role_id: FIXTURE_ROLE_IDS.rampIv }, { actor: 'agent', now: () => new Date() });
      expect(out.status).toBe('ok');
      // A human runs.start would launch the runner: the demo's launcher refuses, so the run ends as error.
      const run = await demo.engine.runOp('runs.start', { skill: 'scout' }, { actor: 'human', now: () => new Date() });
      expect(run.status).toBe('ok');
    } finally {
      demo.close();
      rmSync(dirname(demo.home), { recursive: true, force: true });
    }
  });
});
