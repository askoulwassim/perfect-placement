import type { OpContext } from '@perfect-placement/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';

/*
 * roles.score through runOp on a temp fixture vault (lane A repos, runOp's emitter, lane F mechanics).
 */

let e: FixtureEngine;
let db: FixtureEngine['db'];
const ctx: OpContext = ctxAt('agent', {}, '2026-10-08T12:00:00.000Z');

const crit = (s: string) => Object.fromEntries([...s].map((v, i) => [`c${i + 1}`, Number(v)]));
const status = (id: string) =>
  db.prepare('SELECT status, archive_reason, held_reason FROM role WHERE id = ?').get(id) as Record<string, string | null>;
const events = (type: string) =>
  db.prepare('SELECT subject_id FROM event WHERE type = ? AND length(id) > 10').all(type) as Array<{ subject_id: string }>;
const score = async (input: Record<string, unknown>, c: OpContext = ctx) => okOut(await e.runOp('roles.score', input, c));

function addRole(id: string, company: string, st = 'inbox', found = '2026-10-08T08:00:00.000Z') {
  db.prepare(
    `INSERT INTO role (id, company_id, title, source, found_at, workplace, status, created_at, updated_at) VALUES (?, ?, ?, 'scout', ?, 'remote', ?, ?, ?)`,
  ).run(id, company, id, found, st, found, found);
}

beforeEach(() => {
  e = openFixtureEngine();
  db = e.db;
});
afterEach(() => e.cleanup());

describe('roles.score', () => {
  it('scores an inbox role to active and records profile version + rubric snapshot', async () => {
    const r = {
      output: await score({
        role_id: 'notion_product-lead-data-platform',
        criteria: crit('555555555'),
        facts: { workplace: 'remote', remote_ok: true },
      }),
    };
    expect(r.output.status).toBe('active');
    expect(r.output.score.profile_version_id).toBe('pv_0002');
    expect(r.output.score.rubric_json).toMatchObject({ version: 'profile:pv_0002', affinity_cap: 5, scale: 'v1' });
    const row = db.prepare('SELECT * FROM score WHERE id = ?').get(r.output.score.id) as Record<string, unknown>;
    expect(row.total).toBe(100);
    expect(JSON.parse(row.rubric_json as string).weights.c1).toBe(15);
    expect(status('notion_product-lead-data-platform').status).toBe('active');
    expect(events('role_scored').map((e) => e.subject_id)).toEqual(['notion_product-lead-data-platform']);
  });

  it('archives a dealbreaker even at max affinity (no bypass)', async () => {
    addRole('linear_onsite-pm', 'linear');
    const r = { output: await score({ role_id: 'linear_onsite-pm', criteria: crit('555555555'), facts: { workplace: 'onsite' } }, ctx) };
    expect(r.output.score.affinity_mod).toBe(3);
    expect(r.output.status).toBe('archived');
    expect(status('linear_onsite-pm')).toMatchObject({ status: 'archived', archive_reason: 'dealbreaker' });
    expect(events('role_archived')).toHaveLength(1);
  });

  it('caps affinity at config.scoring.affinity_cap', async () => {
    e.cleanup();
    e = openFixtureEngine({ config: { scoring: { affinity_cap: 2 } } });
    db = e.db;
    addRole('linear_pm-x', 'linear');
    const out = await score({ role_id: 'linear_pm-x', criteria: crit('444444444'), facts: { workplace: 'remote' } });
    expect(out.score.affinity_mod).toBe(2);
    expect(out.score.total).toBe(82); // v1 scale: all 4s = 80, + 2
  });

  it('holds a fourth datadog role below the top three', async () => {
    addRole('datadog_new-pm', 'datadog');
    const out = await score({ role_id: 'datadog_new-pm', criteria: crit('444444444'), facts: { workplace: 'remote' } });
    expect(out).toMatchObject({ status: 'held', held: true });
    expect(out.score.decision).toBe('held');
    expect(status('datadog_new-pm')).toMatchObject({ status: 'held', held_reason: 'company_cap' });
  });

  it('a stronger new role takes a slot and bumps the weakest active to held', async () => {
    addRole('datadog_star-pm', 'datadog');
    const out = await score({ role_id: 'datadog_star-pm', criteria: crit('555555555'), facts: { workplace: 'remote' } });
    expect(out.status).toBe('active');
    expect(out.cap).toEqual([{ role_id: 'datadog_group-pm-cloud-cost', from: 'active', to: 'held' }]);
    expect(status('datadog_group-pm-cloud-cost')).toMatchObject({ status: 'held', held_reason: 'company_cap' });
    expect(events('role_held').map((x) => x.subject_id)).toEqual(['datadog_group-pm-cloud-cost']);
  });

  it('promotes the best held role when an active one is archived by a rescore', async () => {
    const out = await score({ role_id: 'datadog_staff-pm-data-pipelines', criteria: crit('222222222'), facts: {} });
    expect(out.status).toBe('archived');
    expect(out.cap).toEqual([{ role_id: 'datadog_pm-data-jobs-monitoring', from: 'held', to: 'active' }]);
    expect(status('datadog_pm-data-jobs-monitoring')).toMatchObject({ status: 'active', held_reason: null });
    expect(events('role_promoted').map((x) => x.subject_id)).toEqual(['datadog_pm-data-jobs-monitoring']);
  });

  it('a move out of active rebalances the company cap (lane B moveRole -> lane F rebalanceCompany)', async () => {
    okOut(await e.runOp('roles.move', { role_id: 'datadog_principal-pm-llm-observability', to: 'on-deck' }, ctxAt('human')));
    // #13: on-deck does not count toward the cap, so the best held role is promoted.
    expect(status('datadog_pm-data-jobs-monitoring')).toMatchObject({ status: 'active', held_reason: null });
    expect(events('role_promoted').map((x) => x.subject_id)).toEqual(['datadog_pm-data-jobs-monitoring']);
  });

  it('never downgrades draft-ready or later; records the score and keeps status', async () => {
    const out = await score({ role_id: 'linear_product-lead-insights', criteria: crit('111111111'), facts: {} });
    expect(out.status).toBe('draft-ready');
    expect(out.score.decision).toBe('archived');
    expect(out.score.facts_json.status_kept).toBe('draft-ready');
    expect(status('linear_product-lead-insights').status).toBe('draft-ready');
  });

  it('on-deck is protected from rescoring (#13)', async () => {
    const out = await score({ role_id: 'stripe_staff-pm-data-platform', criteria: crit('111111111'), facts: {} });
    expect(out.status).toBe('on-deck');
    expect(out.score.facts_json.status_kept).toBe('on-deck');
  });

  it('revives a below-threshold archive but not a closed one', async () => {
    expect(
      (await score({ role_id: 'snowflake_senior-pm-marketplace', criteria: crit('555555555'), facts: { workplace: 'remote' } })).status,
    ).toBe('active');
    expect(
      (await score({ role_id: 'vercel_staff-pm-edge-network', criteria: crit('555555555'), facts: { workplace: 'remote' } })).status,
    ).toBe('archived');
    expect(status('vercel_staff-pm-edge-network').archive_reason).toBe('closed');
  });

  it('appends score rows on rescore and keeps rationale in the role markdown', async () => {
    const id = 'plaid_staff-pm-data-products';
    await score({ role_id: id, criteria: crit('444444444'), facts: {} });
    await score({ role_id: id, criteria: crit('555555555'), facts: {}, notes: { c4: 'Owns the data contract layer.' } });
    expect((db.prepare('SELECT COUNT(*) n FROM score WHERE role_id = ?').get(id) as { n: number }).n).toBe(2);
    const md = okOut(await e.runOp('roles.get', { role_id: id }, ctx)).md_body as string;
    expect(md).toContain('C4: Owns the data contract layer.');
  });

  it('dry run writes nothing', async () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM score').get() as { n: number }).n;
    const out = await score({ role_id: 'plaid_staff-pm-data-products', criteria: crit('555555555'), facts: {} }, { ...ctx, dryRun: true });
    expect(out.status).toBe('active');
    expect((db.prepare('SELECT COUNT(*) n FROM score').get() as { n: number }).n).toBe(before);
    expect(status('plaid_staff-pm-data-products').status).toBe('inbox');
  });

  it('rejects bad input and unknown roles', async () => {
    expect(await e.runOp('roles.score', { role_id: 'x', criteria: crit('55555555'), facts: {} }, ctx)).toMatchObject({
      code: 'invalid_input',
    });
    expect(await e.runOp('roles.score', { role_id: 'nope', criteria: crit('555555555'), facts: {} }, ctx)).toMatchObject({
      code: 'not_found',
    });
  });
});
