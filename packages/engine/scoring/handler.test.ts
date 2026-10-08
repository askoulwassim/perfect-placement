import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type OpContext, type PolicyConfig } from '@perfect-placement/contracts';
import { FIXTURE_SEED_SQL } from '@perfect-placement/fixtures';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../db/index.js';
import { rebalanceCompany, rolesScoreHandler, ScoringError } from './handler.js';
import { createSqliteScoringStore, type ScoringStore } from './store.js';

/*
 * WAVE 1 SHIM TEST: temp better-sqlite3 db from migrations + the synthetic fixture seed.
 * Wave 2 reruns these through runOp once lanes A and B land.
 */

let dir: string;
let db: Database.Database;
let store: ScoringStore;
const ctx: OpContext = { actor: 'agent', now: () => new Date('2026-10-08T12:00:00.000Z') };
// Fixture scores use the zero-based formula; keep the pool comparable.
const deps = (config: PolicyConfig = DEFAULT_CONFIG) => ({ store, config, scale: 'v1' as const });

const crit = (s: string) => Object.fromEntries([...s].map((v, i) => [`c${i + 1}`, Number(v)]));
const status = (id: string) =>
  db.prepare('SELECT status, archive_reason, held_reason FROM role WHERE id = ?').get(id) as Record<string, string | null>;
const events = (type: string) =>
  db.prepare('SELECT subject_id FROM event WHERE type = ? AND length(id) > 10').all(type) as Array<{ subject_id: string }>;

function addRole(id: string, company: string, st = 'inbox', found = '2026-10-08T08:00:00.000Z') {
  db.prepare(
    `INSERT INTO role (id, company_id, title, source, found_at, workplace, status, created_at, updated_at) VALUES (?, ?, ?, 'scout', ?, 'remote', ?, ?, ?)`,
  ).run(id, company, id, found, st, found, found);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pp-scoring-'));
  db = new Database(join(dir, 'pp.db'));
  for (const f of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  db.exec(readFileSync(FIXTURE_SEED_SQL, 'utf8'));
  store = createSqliteScoringStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('roles.score', () => {
  it('scores an inbox role to active and records profile version + rubric snapshot', () => {
    const r = rolesScoreHandler(
      { role_id: 'notion_product-lead-data-platform', criteria: crit('555555555'), facts: { workplace: 'remote', remote_ok: true } },
      ctx,
      deps(),
    );
    expect(r.output.status).toBe('active');
    expect(r.output.score.profile_version_id).toBe('pv_0002');
    expect(r.output.score.rubric_json).toMatchObject({ version: 'profile:pv_0002', affinity_cap: 5, scale: 'v1' });
    const row = db.prepare('SELECT * FROM score WHERE id = ?').get(r.output.score.id) as Record<string, unknown>;
    expect(row.total).toBe(100);
    expect(JSON.parse(row.rubric_json as string).weights.c1).toBe(15);
    expect(status('notion_product-lead-data-platform').status).toBe('active');
    expect(events('role_scored').map((e) => e.subject_id)).toEqual(['notion_product-lead-data-platform']);
  });

  it('archives a dealbreaker even at max affinity (no bypass)', () => {
    addRole('linear_onsite-pm', 'linear');
    const r = rolesScoreHandler({ role_id: 'linear_onsite-pm', criteria: crit('555555555'), facts: { workplace: 'onsite' } }, ctx, deps());
    expect(r.output.score.affinity_mod).toBe(3);
    expect(r.output.status).toBe('archived');
    expect(status('linear_onsite-pm')).toMatchObject({ status: 'archived', archive_reason: 'dealbreaker' });
    expect(events('role_archived')).toHaveLength(1);
  });

  it('caps affinity at config.scoring.affinity_cap', () => {
    const config = { ...DEFAULT_CONFIG, scoring: { ...DEFAULT_CONFIG.scoring, affinity_cap: 2 } };
    addRole('linear_pm-x', 'linear');
    const r = rolesScoreHandler({ role_id: 'linear_pm-x', criteria: crit('444444444'), facts: { workplace: 'remote' } }, ctx, deps(config));
    expect(r.output.score.affinity_mod).toBe(2);
    expect(r.output.score.total).toBe(82); // v1 scale: all 4s = 80, + 2
  });

  it('holds a fourth datadog role below the top three', () => {
    addRole('datadog_new-pm', 'datadog');
    const r = rolesScoreHandler({ role_id: 'datadog_new-pm', criteria: crit('444444444'), facts: { workplace: 'remote' } }, ctx, deps());
    expect(r.output).toMatchObject({ status: 'held', held: true });
    expect(r.output.score.decision).toBe('held');
    expect(status('datadog_new-pm')).toMatchObject({ status: 'held', held_reason: 'company_cap' });
  });

  it('a stronger new role takes a slot and bumps the weakest active to held', () => {
    addRole('datadog_star-pm', 'datadog');
    const r = rolesScoreHandler({ role_id: 'datadog_star-pm', criteria: crit('555555555'), facts: { workplace: 'remote' } }, ctx, deps());
    expect(r.output.status).toBe('active');
    expect(r.cap).toEqual([{ role_id: 'datadog_group-pm-cloud-cost', from: 'active', to: 'held' }]);
    expect(status('datadog_group-pm-cloud-cost')).toMatchObject({ status: 'held', held_reason: 'company_cap' });
    expect(events('role_held').map((e) => e.subject_id)).toEqual(['datadog_group-pm-cloud-cost']);
  });

  it('promotes the best held role when an active one is archived by a rescore', () => {
    const r = rolesScoreHandler({ role_id: 'datadog_staff-pm-data-pipelines', criteria: crit('222222222'), facts: {} }, ctx, deps());
    expect(r.output.status).toBe('archived');
    expect(r.cap).toEqual([{ role_id: 'datadog_pm-data-jobs-monitoring', from: 'held', to: 'active' }]);
    expect(status('datadog_pm-data-jobs-monitoring')).toMatchObject({ status: 'active', held_reason: null });
    expect(events('role_promoted').map((e) => e.subject_id)).toEqual(['datadog_pm-data-jobs-monitoring']);
  });

  it('rebalanceCompany promotes when a slot frees outside scoring', () => {
    db.prepare(`UPDATE role SET status = 'on-deck' WHERE id = 'datadog_principal-pm-llm-observability'`).run();
    const r = rebalanceCompany('datadog', ctx, deps());
    expect(r.cap).toEqual([{ role_id: 'datadog_pm-data-jobs-monitoring', from: 'held', to: 'active' }]);
    expect(rebalanceCompany('datadog', ctx, deps()).cap).toEqual([]);
  });

  it('never downgrades draft-ready or later; records the score and keeps status', () => {
    const r = rolesScoreHandler({ role_id: 'linear_product-lead-insights', criteria: crit('111111111'), facts: {} }, ctx, deps());
    expect(r.output.status).toBe('draft-ready');
    expect(r.output.score.decision).toBe('archived');
    expect(r.output.score.facts_json.status_kept).toBe('draft-ready');
    expect(status('linear_product-lead-insights').status).toBe('draft-ready');
  });

  it('revives a below-threshold archive but not a closed one', () => {
    expect(
      rolesScoreHandler(
        { role_id: 'snowflake_senior-pm-marketplace', criteria: crit('555555555'), facts: { workplace: 'remote' } },
        ctx,
        deps(),
      ).output.status,
    ).toBe('active');
    expect(
      rolesScoreHandler(
        { role_id: 'vercel_staff-pm-edge-network', criteria: crit('555555555'), facts: { workplace: 'remote' } },
        ctx,
        deps(),
      ).output.status,
    ).toBe('archived');
    expect(status('vercel_staff-pm-edge-network').archive_reason).toBe('closed');
  });

  it('appends score rows on rescore', () => {
    const id = 'plaid_staff-pm-data-products';
    rolesScoreHandler({ role_id: id, criteria: crit('444444444'), facts: {} }, ctx, deps());
    rolesScoreHandler({ role_id: id, criteria: crit('555555555'), facts: {} }, ctx, deps());
    expect((db.prepare('SELECT COUNT(*) n FROM score WHERE role_id = ?').get(id) as { n: number }).n).toBe(2);
  });

  it('dry run writes nothing', () => {
    const before = (db.prepare('SELECT COUNT(*) n FROM score').get() as { n: number }).n;
    const r = rolesScoreHandler(
      { role_id: 'plaid_staff-pm-data-products', criteria: crit('555555555'), facts: {} },
      { ...ctx, dryRun: true },
      deps(),
    );
    expect(r.output.status).toBe('active');
    expect((db.prepare('SELECT COUNT(*) n FROM score').get() as { n: number }).n).toBe(before);
    expect(status('plaid_staff-pm-data-products').status).toBe('inbox');
  });

  it('rejects bad input and unknown roles', () => {
    expect(() => rolesScoreHandler({ role_id: 'x', criteria: crit('55555555'), facts: {} }, ctx, deps())).toThrow(ScoringError);
    try {
      rolesScoreHandler({ role_id: 'nope', criteria: crit('555555555'), facts: {} }, ctx, deps());
    } catch (e) {
      expect((e as ScoringError).code).toBe('not_found');
    }
  });
});
