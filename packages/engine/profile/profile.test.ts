import { CRITERIA, PROFILE_COMPONENT_KEYS } from '@perfect-placement/contracts';
import { profileComponents } from '@perfect-placement/fixtures';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ctxAt, type FakeScript, type FixtureEngine, okOut, openFixtureEngine, tickingClock } from '../testing/index.js';
import {
  COMPONENT_DATA_SCHEMAS,
  impactForComponent,
  NEUTRAL_WEIGHTS,
  normalizeWeights,
  rubricWeights,
  safeParseComponentData,
  weightsByComponent,
} from './components.js';

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
      data_json: { criterion_weights: by[key].criterion_weights },
    }));
    expect(rubricWeights(comps)).toEqual(w);
    const fx = rubricWeights(profileComponents.filter((c) => c.version_id === 'pv_0002'));
    expect(CRITERIA.reduce((s, c) => s + fx[c], 0)).toBe(100);
  });

  it('diff impact by kind (wave1-decisions #14): filters high, weighted and asset medium', () => {
    expect(impactForComponent('dealbreakers')).toBe('high');
    expect(impactForComponent('terms')).toBe('high');
    expect(impactForComponent('work_mode')).toBe('high');
    expect(impactForComponent('domain')).toBe('medium');
    expect(impactForComponent('voice')).toBe('medium');
    expect(impactForComponent('story')).toBe('medium');
  });
});

type Comp = { key: string; data_json: Record<string, unknown> };

describe('profile ops through runOp (fixtures)', () => {
  let e: FixtureEngine;
  const clock = tickingClock();
  const human = () => ctxAt('human', {}, clock);
  const agent = () => ctxAt('agent', {}, clock);
  const open = (kev?: FakeScript) => {
    e = openFixtureEngine(kev ? { kev } : {});
  };
  const component = async (key: string, version?: string): Promise<Comp | undefined> =>
    (okOut(await e.runOp('profile.get', version ? { version_id: version } : {}, human())).components as Comp[]).find((c) => c.key === key);
  const diff = (id: string) => e.db.prepare('SELECT * FROM profile_diff WHERE id = ?').get(id) as Record<string, string>;
  const decisionOf = (diffId: string) =>
    e.db.prepare('SELECT * FROM decision WHERE subject_id = ? ORDER BY ts DESC').get(diffId) as Record<string, string>;

  beforeEach(() => open());
  afterEach(() => e.cleanup());

  it('profile.get returns the current version with 11 components and pending diffs', async () => {
    const out = okOut(await e.runOp('profile.get', {}, human()));
    expect(out.version.id).toBe('pv_0002');
    expect(out.components).toHaveLength(11);
    expect(out.pending_diffs).toHaveLength(2);
    expect((await e.runOp('profile.get', { version_id: 'nope' }, human())).status).toBe('error');
  });

  it('profile.history filters by component', async () => {
    expect(okOut(await e.runOp('profile.history', {}, human())).versions).toHaveLength(2);
    expect(okOut(await e.runOp('profile.history', { component: 'domain' }, human())).versions).toHaveLength(2);
  });

  it('propose (agent) -> apply (human) creates v+1, rescores affected roles, emits events', async () => {
    const p = okOut(
      await e.runOp(
        'profile.propose_diff',
        { component: 'growth', before: { trajectory: 'up' }, after: { trajectory: 'broader' }, evidence: ['retro: wants range'] },
        agent(),
      ),
    );
    expect(p.diff.impact).toBe('medium');
    const a = okOut(await e.runOp('profile.apply_diff', { diff_id: p.diff.id }, human()));
    expect(a.version.parent_id).toBe('pv_0002');
    expect(okOut(await e.runOp('profile.get', {}, human())).version.id).toBe(a.version.id);
    expect((await component('growth'))?.data_json.trajectory).toBe('broader');
    expect((await component('domain'))?.data_json).toEqual((await component('domain', 'pv_0002'))?.data_json);
    // Lane F rescore of the movable roles under the new version (on-deck and later never, #13).
    expect(a.rescored_role_ids.length).toBeGreaterThan(0);
    for (const id of a.rescored_role_ids as string[]) {
      const s = (e.db.prepare('SELECT status FROM role WHERE id = ?').get(id) as { status: string }).status;
      expect(['inbox', 'active', 'held', 'archived']).toContain(s);
    }
    const rescored = e.db.prepare('SELECT count(*) n FROM score WHERE profile_version_id = ?').get(a.version.id) as { n: number };
    expect(rescored.n).toBe(a.rescored_role_ids.length);
    expect(diff(p.diff.id).status).toBe('applied');
    const ev = e.db.prepare('SELECT type FROM event WHERE subject_id = ? ORDER BY ts').all(p.diff.id) as { type: string }[];
    expect(ev.map((x) => x.type)).toEqual(['profile_diff_proposed', 'profile_diff_applied']);
  });

  it('propose rejects a wrong before, a no-op and invalid results', async () => {
    const run = (before: Record<string, unknown>, after: Record<string, unknown>, c = 'growth') =>
      e.runOp('profile.propose_diff', { component: c, before, after, evidence: ['e'] }, human());
    expect(await run({ trajectory: 'down' }, { trajectory: 'x' })).toMatchObject({ code: 'conflict' });
    expect(await run({ trajectory: 'up' }, { trajectory: 'up' })).toMatchObject({ code: 'invalid_input' });
    expect(await run({ comp_floor: 200000 }, { comp_floor: -5 }, 'terms')).toMatchObject({ code: 'invalid_input' });
  });

  it('a comp floor change is a hard exclusion: agent gets requires_human, the human accept applies it', async () => {
    e.cleanup();
    open(() => ({ value: true, p: 0.99 })); // even a confident Kev cannot auto-apply it
    // pd_0001: terms comp floor, linked to dc_0003 (pending, human).
    expect(await e.runOp('profile.apply_diff', { diff_id: 'pd_0001' }, agent())).toEqual({
      status: 'requires_human',
      decisionId: 'dc_0003',
    });
    expect(diff('pd_0001').status).toBe('pending');
    // An agent passing the unresolved decision id is still refused.
    const sneaky = await e.runOp('profile.apply_diff', { diff_id: 'pd_0001' }, ctxAt('agent', { decisionId: 'dc_0003' }, clock));
    expect(sneaky.status).toBe('requires_human');
    // The human accepts in Needs you: decisions.resolve runs the queued action.
    const r = okOut(await e.runOp('decisions.resolve', { decision_id: 'dc_0003', action: 'accept' }, human()));
    expect(r.op_status).toBe('ok');
    expect((await component('terms'))?.data_json.comp_floor).toBe(215000);
  });

  it('a fresh comp floor diff from an agent goes to a human even with Kev at 0.99', async () => {
    e.cleanup();
    open(() => ({ value: true, p: 0.99 }));
    const p = okOut(
      await e.runOp(
        'profile.propose_diff',
        { component: 'terms', before: { comp_floor: 200000 }, after: { comp_floor: 190000 }, evidence: ['market'] },
        agent(),
      ),
    );
    expect((await e.runOp('profile.apply_diff', { diff_id: p.diff.id }, agent())).status).toBe('requires_human');
    expect(decisionOf(p.diff.id)).toMatchObject({ policy_outcome: 'human', backend: 'kev' });
  });

  it('a non-excluded filter change (work mode) follows the high row: confident -> auto + undo', async () => {
    e.cleanup();
    open(() => ({ value: true, p: 0.95 }));
    const wm = (await component('work_mode'))?.data_json ?? {};
    const p = okOut(
      await e.runOp(
        'profile.propose_diff',
        {
          component: 'work_mode',
          before: { modes: wm.modes },
          after: { modes: ['remote', 'hybrid'] },
          evidence: ['took a hybrid interview'],
        },
        agent(),
      ),
    );
    expect(p.diff.impact).toBe('high');
    okOut(await e.runOp('profile.apply_diff', { diff_id: p.diff.id }, agent()));
    expect(decisionOf(p.diff.id)).toMatchObject({ policy_outcome: 'auto_undo', impact: 'high' });
  });

  it('a confident medium diff applies with a 24h undo (#14 via confident_outcome); decisions.undo restores it', async () => {
    e.cleanup();
    open(() => ({ value: true, p: 0.95 }));
    const out = okOut(await e.runOp('profile.apply_diff', { diff_id: 'pd_0002' }, agent()));
    expect(out.version.parent_id).toBe('pv_0002');
    const row = decisionOf('pd_0002');
    expect(row).toMatchObject({ policy_outcome: 'auto_undo', status: 'applied', backend: 'kev' });
    expect(row.undo_until).not.toBeNull();
    expect(JSON.parse(row.action_json as string)).toEqual({
      op: 'profile.apply_diff',
      input: { diff_id: 'pd_0002' },
      when: true,
      undo: { op: 'profile.undo_diff', input: { diff_id: 'pd_0002' } },
    });
    const before = (await component('domain', 'pv_0002'))?.data_json;
    okOut(await e.runOp('decisions.undo', { decision_id: row.id }, human()));
    expect((await component('domain'))?.data_json).toEqual(before);
    expect(diff('pd_0002').status).toBe('undone');
  });

  it('asset diffs are medium (#14): confident -> auto + undo; unsure -> human', async () => {
    e.cleanup();
    let p = 0.95;
    open(() => ({ value: true, p }));
    const propose = async (style: string) => {
      const voice = (await component('voice'))?.data_json ?? {};
      return okOut(
        await e.runOp(
          'profile.propose_diff',
          { component: 'voice', before: { style: voice.style }, after: { style }, evidence: ['reply rate'] },
          agent(),
        ),
      ).diff;
    };
    const d1 = await propose('Shorter, warmer.');
    expect(d1.impact).toBe('medium');
    okOut(await e.runOp('profile.apply_diff', { diff_id: d1.id }, agent()));
    expect(decisionOf(d1.id).policy_outcome).toBe('auto_undo');
    p = 0.6;
    const d2 = await propose('Formal.');
    expect((await e.runOp('profile.apply_diff', { diff_id: d2.id }, agent())).status).toBe('requires_human');
  });

  it('Kev down: the agent backend answers only when the agent states its confidence (#9, #17)', async () => {
    // No confidence: yields to a human.
    expect((await e.runOp('profile.apply_diff', { diff_id: 'pd_0002' }, agent())).status).toBe('requires_human');
    expect(decisionOf('pd_0002')).toMatchObject({ backend: 'human', policy_outcome: 'human' });
    e.cleanup();
    open();
    const o = okOut(
      await e.runOp('profile.apply_diff', { diff_id: 'pd_0002' }, ctxAt('agent', { confidence: { p: 0.96, backend: 'agent' } }, clock)),
    );
    expect(o.version.parent_id).toBe('pv_0002');
    expect(decisionOf('pd_0002')).toMatchObject({ backend: 'agent', policy_outcome: 'auto_undo' });
  });

  it('reject_diff marks rejected and blocks a later apply; a stale diff conflicts', async () => {
    okOut(await e.runOp('profile.reject_diff', { diff_id: 'pd_0002', reason: 'no' }, human()));
    expect(await e.runOp('profile.apply_diff', { diff_id: 'pd_0002' }, human())).toMatchObject({ code: 'conflict' });
    const prop = async (after: string) =>
      okOut(
        await e.runOp(
          'profile.propose_diff',
          { component: 'growth', before: { trajectory: 'up' }, after: { trajectory: after }, evidence: ['a'] },
          human(),
        ),
      ).diff.id as string;
    const id1 = await prop('deeper');
    const id2 = await prop('steady');
    okOut(await e.runOp('profile.apply_diff', { diff_id: id1 }, human()));
    expect(await e.runOp('profile.apply_diff', { diff_id: id2 }, human())).toMatchObject({ code: 'conflict' });
  });
});
