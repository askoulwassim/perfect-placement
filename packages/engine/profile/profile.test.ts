import { CRITERIA, type OpContext, PROFILE_COMPONENT_KEYS } from '@perfect-placement/contracts';
import { FIXTURE_SEED_SQL, profileComponents } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPONENT_DATA_SCHEMAS,
  impactForComponent,
  NEUTRAL_WEIGHTS,
  normalizeWeights,
  rubricWeights,
  safeParseComponentData,
  weightsByComponent,
} from './components.js';
import type { ProfileDeps } from './deps.js';
import { createProfileHandlers } from './handlers.js';
import { undoDiff } from './profile-ops.js';
import { getComponent, getCurrentVersion, getDiff } from './store.js';
import { createFakeResolver, createTempDb, resolveDecisionAsHuman, testDeps } from './testing.js';

const NOW = new Date('2026-10-08T12:00:00.000Z');
let tick = 0;
const ctx = (actor: OpContext['actor'] = 'human', extra: Partial<OpContext> = {}): OpContext => ({
  actor,
  now: () => new Date(NOW.getTime() + ++tick * 1000),
  ...extra,
});

describe('component schemas + weights', () => {
  it('accept every fixture component', () => {
    for (const c of profileComponents) expect(safeParseComponentData(c.key, c.data_json).success, c.key).toBe(true);
    expect(Object.keys(COMPONENT_DATA_SCHEMAS).sort()).toEqual([...PROFILE_COMPONENT_KEYS].sort());
  });

  it('keep unknown fields (nothing silently dropped)', () => {
    const r = safeParseComponentData('craft', { functions: ['PM'], something_new: 1 });
    expect(r.success && (r.data as Record<string, unknown>).something_new).toBe(1);
  });

  it('reject invalid data', () => {
    expect(safeParseComponentData('company', { affinity: { x: 9 } }).success).toBe(false);
    expect(safeParseComponentData('terms', { comp_floor: -1 }).success).toBe(false);
  });

  it('normalize to integers summing to 100', () => {
    const w = normalizeWeights({ c1: 1, c2: 1, c3: 1, c4: 1, c5: 1, c6: 1, c7: 1, c8: 1, c9: 1 });
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBe(100);
    expect(normalizeWeights(NEUTRAL_WEIGHTS)).toEqual(NEUTRAL_WEIGHTS);
  });

  it('round-trip rubric weights through components', () => {
    const w = { c1: 15, c2: 15, c3: 12, c4: 12, c5: 10, c6: 12, c7: 8, c8: 8, c9: 8 };
    const by = weightsByComponent(w);
    expect(by.team.weight).toBe(0.23);
    expect(by.terms.weight).toBeNull();
    const comps = PROFILE_COMPONENT_KEYS.map((key) => ({
      key,
      weight: by[key].weight,
      data_json: { criteria_weights: by[key].criteria_weights },
    }));
    expect(rubricWeights(comps)).toEqual(w);
    // Fixture components carry only the weight column: still a valid rubric.
    const fx = rubricWeights(profileComponents.filter((c) => c.version_id === 'pv_0002'));
    expect(CRITERIA.reduce((s, c) => s + fx[c], 0)).toBe(100);
  });

  it('tier impact by kind', () => {
    expect(impactForComponent('dealbreakers')).toBe('high');
    expect(impactForComponent('terms')).toBe('high');
    expect(impactForComponent('work_mode')).toBe('high');
    expect(impactForComponent('domain')).toBe('medium');
    expect(impactForComponent('voice')).toBe('low');
  });
});

describe('profile ops on fixtures', () => {
  let env: ReturnType<typeof createTempDb>;
  let deps: ProfileDeps;
  let ops: ReturnType<typeof createProfileHandlers>;

  beforeEach(() => {
    env = createTempDb(FIXTURE_SEED_SQL);
    deps = testDeps(env.db);
    ops = createProfileHandlers(deps);
  });
  afterEach(() => env.cleanup());

  it('profile.get returns the current version with 11 components and pending diffs', async () => {
    const r = await ops['profile.get']({}, ctx());
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const out = r.output as { version: { id: string }; components: unknown[]; pending_diffs: unknown[] };
    expect(out.version.id).toBe('pv_0002');
    expect(out.components).toHaveLength(11);
    expect(out.pending_diffs).toHaveLength(2);
    expect((await ops['profile.get']({ version_id: 'nope' }, ctx())).status).toBe('error');
  });

  it('profile.history filters by component', async () => {
    const all = await ops['profile.history']({}, ctx());
    const dom = await ops['profile.history']({ component: 'domain' }, ctx());
    const net = await ops['profile.history']({ component: 'network' }, ctx());
    expect(all.status === 'ok' && (all.output as { versions: unknown[] }).versions).toHaveLength(2);
    expect(dom.status === 'ok' && (dom.output as { versions: unknown[] }).versions).toHaveLength(2);
    // network changed confidence between pv_0001 and pv_0002 too
    expect(net.status === 'ok' && (net.output as { versions: unknown[] }).versions.length).toBeGreaterThanOrEqual(1);
  });

  it('propose -> apply (human) creates v+1, emits events, leaves other components alone', async () => {
    const p = await ops['profile.propose_diff'](
      { component: 'growth', before: { trajectory: 'up' }, after: { trajectory: 'broader' }, evidence: ['retro: wants range'] },
      ctx('agent'),
    );
    expect(p.status).toBe('ok');
    if (p.status !== 'ok') return;
    const diff = (p.output as { diff: { id: string; impact: string; status: string } }).diff;
    expect(diff.impact).toBe('medium');
    expect(p.eventIds).toHaveLength(1);

    const a = await ops['profile.apply_diff']({ diff_id: diff.id }, ctx('human'));
    expect(a.status).toBe('ok');
    if (a.status !== 'ok') return;
    const out = a.output as { version: { id: string; parent_id: string }; rescored_role_ids: string[] };
    expect(out.version.parent_id).toBe('pv_0002');
    expect(getCurrentVersion(env.db)?.id).toBe(out.version.id);
    expect(getComponent(env.db, out.version.id, 'growth')?.data_json.trajectory).toBe('broader');
    expect(getComponent(env.db, out.version.id, 'domain')?.data_json).toEqual(getComponent(env.db, 'pv_0002', 'domain')?.data_json);
    expect(out.rescored_role_ids.length).toBeGreaterThan(0);
    expect(getDiff(env.db, diff.id)?.status).toBe('applied');
    const ev = env.db.prepare(`SELECT type FROM event WHERE subject_id = ? ORDER BY ts`).all(diff.id) as { type: string }[];
    expect(ev.map((e) => e.type)).toEqual(['profile_diff_proposed', 'profile_diff_applied']);
  });

  it('propose rejects a wrong before, a no-op and invalid results', async () => {
    const wrong = await ops['profile.propose_diff'](
      { component: 'growth', before: { trajectory: 'down' }, after: { trajectory: 'x' }, evidence: ['e'] },
      ctx(),
    );
    expect(wrong.status === 'error' && wrong.code).toBe('conflict');
    const noop = await ops['profile.propose_diff'](
      { component: 'growth', before: { trajectory: 'up' }, after: { trajectory: 'up' }, evidence: ['e'] },
      ctx(),
    );
    expect(noop.status === 'error' && noop.code).toBe('invalid_input');
    const bad = await ops['profile.propose_diff'](
      { component: 'terms', before: { comp_floor: 200000 }, after: { comp_floor: -5 }, evidence: ['e'] },
      ctx(),
    );
    expect(bad.status === 'error' && bad.code).toBe('invalid_input');
  });

  it('never auto-applies a filter change: agent gets requires_human, human approval applies', async () => {
    // pd_0001: terms comp floor, high, linked to dc_0003 (pending, human).
    const agent = await ops['profile.apply_diff']({ diff_id: 'pd_0001' }, ctx('agent'));
    expect(agent).toEqual({ status: 'requires_human', decisionId: 'dc_0003' });
    expect(getDiff(env.db, 'pd_0001')?.status).toBe('pending');
    // An agent passing an unresolved decision id is still refused.
    const sneaky = await ops['profile.apply_diff']({ diff_id: 'pd_0001' }, ctx('agent', { decisionId: 'dc_0003' }));
    expect(sneaky.status).toBe('requires_human');
    // After the human resolves the decision, the queued action runs.
    resolveDecisionAsHuman(env.db, 'dc_0003', 'true');
    const ok = await ops['profile.apply_diff']({ diff_id: 'pd_0001' }, ctx('agent', { decisionId: 'dc_0003' }));
    expect(ok.status).toBe('ok');
    const v = getCurrentVersion(env.db);
    expect(getComponent(env.db, v?.id ?? '', 'terms')?.data_json.comp_floor).toBe(215000);
  });

  it('agent apply of a medium diff routes through the resolver', async () => {
    const confident = createFakeResolver(env.db, () => ({ value: true, p: 0.95 }));
    const opsC = createProfileHandlers({ ...deps, ask: confident });
    const r = await opsC['profile.apply_diff']({ diff_id: 'pd_0002' }, ctx('agent'));
    expect(r.status).toBe('ok');
    const row = env.db
      .prepare('SELECT policy_outcome, undo_until, action_json FROM decision WHERE subject_id = ?')
      .get('pd_0002') as Record<string, string>;
    expect(row.policy_outcome).toBe('auto_undo');
    expect(row.undo_until).toBeTruthy();
    expect(JSON.parse(row.action_json)).toEqual({ op: 'profile.apply_diff', input: { diff_id: 'pd_0002' } });

    // Undo inside the window restores the before values.
    const before = getComponent(env.db, 'pv_0002', 'domain')?.data_json;
    const { version } = await undoDiff(deps, 'pd_0002', ctx('human'));
    expect(getComponent(env.db, version.id, 'domain')?.data_json).toEqual(before);
    expect(getDiff(env.db, 'pd_0002')?.status).toBe('undone');
  });

  it('agent apply of a medium diff at middle confidence goes to a human', async () => {
    const unsure = createFakeResolver(env.db, () => ({ value: true, p: 0.8 }));
    const r = await createProfileHandlers({ ...deps, ask: unsure })['profile.apply_diff']({ diff_id: 'pd_0002' }, ctx('agent'));
    expect(r.status).toBe('requires_human');
    expect(getDiff(env.db, 'pd_0002')?.status).toBe('pending');
  });

  it('reject_diff marks rejected and blocks a later apply', async () => {
    const r = await ops['profile.reject_diff']({ diff_id: 'pd_0002', reason: 'no' }, ctx());
    expect(r.status).toBe('ok');
    const again = await ops['profile.apply_diff']({ diff_id: 'pd_0002' }, ctx());
    expect(again.status === 'error' && again.code).toBe('conflict');
  });

  it('a stale diff conflicts', async () => {
    const p1 = await ops['profile.propose_diff'](
      { component: 'growth', before: { trajectory: 'up' }, after: { trajectory: 'deeper' }, evidence: ['a'] },
      ctx(),
    );
    const p2 = await ops['profile.propose_diff'](
      { component: 'growth', before: { trajectory: 'up' }, after: { trajectory: 'steady' }, evidence: ['b'] },
      ctx(),
    );
    if (p1.status !== 'ok' || p2.status !== 'ok') throw new Error('propose failed');
    const id1 = (p1.output as { diff: { id: string } }).diff.id;
    const id2 = (p2.output as { diff: { id: string } }).diff.id;
    expect((await ops['profile.apply_diff']({ diff_id: id1 }, ctx())).status).toBe('ok');
    const s = await ops['profile.apply_diff']({ diff_id: id2 }, ctx());
    expect(s.status === 'error' && s.code).toBe('conflict');
  });
});
