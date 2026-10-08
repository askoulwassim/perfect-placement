import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '@perfect-placement/contracts';
import { FIXTURE_ROLE_IDS } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { okOut } from '../_shim/assert.js';
import { ctxAt, type FixtureEngine, openFixtureEngine } from '../_shim/testing.js';

let e: FixtureEngine;
beforeEach(() => {
  e = openFixtureEngine();
});
afterEach(() => e.cleanup());

describe('runs', () => {
  it('start -> ops inside the run -> finish, with one log file', async () => {
    const { run } = okOut(await e.runOp('runs.start', { skill: 'scout' }, ctxAt()));
    expect(run).toMatchObject({ op: 'scout', status: 'running', log_path: 'runs/2026-10-08_scout.md' });
    const ctx = ctxAt('agent', { runId: run.id });
    okOut(await e.runOp('roles.add', { candidates: [{ company_name: 'Acme', title: 'Staff PM', source: 'scout' }] }, ctx));
    const fin = okOut(await e.runOp('runs.finish', { run_id: run.id, status: 'ok', summary: { queries: 4 } }, ctx));
    expect(fin.run).toMatchObject({ status: 'ok', finished_at: '2026-10-08T12:00:00.000Z' });
    expect(fin.run.summary_json).toMatchObject({ skill: 'scout', queries: 4, 'roles.add': { added: 1 } });
    const got = okOut(await e.runOp('runs.get', { run_id: run.id }, ctxAt()));
    expect(got.log_md).toContain('## roles.add');
    expect(got.log_md).toContain('acme_staff-pm');
    expect(got.log_md).toContain('## Finished');
    expect(await e.runOp('runs.finish', { run_id: run.id, status: 'ok' }, ctx)).toMatchObject({ code: 'conflict' });
    // a second run the same day gets its own file
    const second = okOut(await e.runOp('runs.start', { skill: 'scout' }, ctxAt()));
    expect(second.run.log_path).toBe('runs/2026-10-08_scout-2.md');
  });

  it('start for one role validates the role', async () => {
    const ok = okOut(await e.runOp('runs.start', { skill: 'tailor', role_id: FIXTURE_ROLE_IDS.stripeOnDeck }, ctxAt()));
    expect(ok.run.log_path).toBe(`runs/2026-10-08_tailor_${FIXTURE_ROLE_IDS.stripeOnDeck}.md`);
    expect(await e.runOp('runs.start', { skill: 'tailor', role_id: 'nope' }, ctxAt())).toMatchObject({ code: 'not_found' });
  });

  it('an unknown runId fails the op', async () => {
    const o = await e.runOp(
      'roles.add',
      { candidates: [{ company_name: 'Acme', title: 'PM', source: 'scout' }] },
      ctxAt('agent', { runId: 'rn_x' }),
    );
    expect(o).toMatchObject({ code: 'not_found' });
  });

  it('list pages newest first and filters by op; get 404s', async () => {
    const all = okOut(await e.runOp('runs.list', { limit: 2 }, ctxAt()));
    expect(all.items).toHaveLength(2);
    expect(all.items[0].started_at >= all.items[1].started_at).toBe(true);
    const ops = okOut(await e.runOp('runs.list', { op: all.items[0].op }, ctxAt()));
    expect(ops.items.every((r: { op: string }) => r.op === all.items[0].op)).toBe(true);
    expect(await e.runOp('runs.get', { run_id: 'rn_nope' }, ctxAt())).toMatchObject({ code: 'not_found' });
  });
});

describe('config', () => {
  it('get reads config.json over defaults', async () => {
    expect(okOut(await e.runOp('config.get', {}, ctxAt()))).toEqual(DEFAULT_CONFIG);
  });

  it('update deep-merges, validates and writes; agents are queued', async () => {
    const out = okOut(await e.runOp('config.update', { patch: { scoring: { company_active_cap: 4 } } }, ctxAt('human')));
    expect(out.scoring).toEqual({ ...DEFAULT_CONFIG.scoring, company_active_cap: 4 });
    expect(JSON.parse(readFileSync(join(e.home, 'config.json'), 'utf8')).scoring.company_active_cap).toBe(4);
    expect(await e.runOp('config.update', { patch: { policy: { auto: 7 } } }, ctxAt('human'))).toMatchObject({ code: 'invalid_input' });
    expect((await e.runOp('config.update', { patch: { policy: { auto: 0.5 } } }, ctxAt('agent'))).status).toBe('requires_human');
    expect(okOut(await e.runOp('config.get', {}, ctxAt())).policy.auto).toBe(0.9);
  });

  it('the cap from config drives held promotion', async () => {
    okOut(await e.runOp('config.update', { patch: { scoring: { company_active_cap: 5 } } }, ctxAt('human')));
    okOut(await e.runOp('roles.archive', { role_id: FIXTURE_ROLE_IDS.datadogActive, reason: 'passed' }, ctxAt('human')));
    const held = (e.db.prepare(`SELECT count(*) n FROM role WHERE company_id = 'datadog' AND status = 'held'`).get() as { n: number }).n;
    expect(held).toBe(0);
  });
});
