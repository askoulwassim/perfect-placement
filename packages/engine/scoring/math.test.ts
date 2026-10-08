import { DEFAULT_CONFIG, type ProfileComponent } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { allocateCompanySlots, capTransitions } from './cap.js';
import { affinityFor, affinityMod, bandFor, baseTotal, type Criteria, computeScore, evaluateDealbreakers } from './math.js';
import { normalizeWeights, profileCriterionWeights, rubricFor, rubricSnapshot, V1_WEIGHTS } from './rubric.js';
import { maxWatchlist, planSourceMix, type ScoutQuery, watchlistFrom } from './source-mix.js';

const all = (n: number): Criteria => ({ c1: n, c2: n, c3: n, c4: n, c5: n, c6: n, c7: n, c8: n, c9: n });
const comp = (key: ProfileComponent['key'], data: Record<string, unknown>): ProfileComponent => ({
  id: `pc_${key}`,
  version_id: 'pv_t',
  key,
  kind: 'filter',
  confidence: 1,
  weight: null,
  data_json: data,
  md_path: null,
});
const REMOTE_ONLY = [comp('work_mode', { modes: ['remote'] })];
const rubric = rubricFor({ config: DEFAULT_CONFIG, profileVersionId: null, components: [] });

describe('totals', () => {
  it('v1 scale matches scorer.py: round(sum(c*w)/5)', () => {
    expect(baseTotal(all(5), rubric)).toBe(100);
    expect(baseTotal(all(1), rubric)).toBe(20);
    const c: Criteria = { c1: 4, c2: 5, c3: 5, c4: 4, c5: 5, c6: 5, c7: 5, c8: 5, c9: 5 };
    const v1 = Math.round((4 * 15 + 5 * 15 + 5 * 12 + 4 * 12 + 5 * 10 + 5 * 12 + 5 * 8 + 5 * 8 + 5 * 8) / 5);
    expect(baseTotal(c, rubric)).toBe(v1);
  });
  it('zero_based scale spans 0..100', () => {
    expect(baseTotal(all(1), { ...rubric, scale: 'zero_based' })).toBe(0);
    expect(baseTotal(all(4), { ...rubric, scale: 'zero_based' })).toBe(75);
  });
  it('rejects out-of-range criteria', () => {
    expect(() => baseTotal({ ...all(3), c4: 6 }, rubric)).toThrow(/c4/);
    expect(() => baseTotal({ ...all(3), c2: 2.5 }, rubric)).toThrow(/c2/);
  });
  it('bands at 75 / 55', () => {
    expect(bandFor(75, rubric)).toBe('green');
    expect(bandFor(74, rubric)).toBe('yellow');
    expect(bandFor(55, rubric)).toBe('yellow');
    expect(bandFor(54, rubric)).toBe('red');
  });
});

describe('affinity (decisions.md #5)', () => {
  it('is capped at +/- affinity_cap', () => {
    expect(affinityMod(99, 5)).toBe(5);
    expect(affinityMod(-7, 5)).toBe(-5);
    expect(affinityMod(3, 2)).toBe(2);
    expect(affinityMod(null, 5)).toBe(0);
  });
  it('cannot lift a role across more than the cap', () => {
    const s = computeScore(all(3), {}, rubric, [], 50);
    expect(s.affinity_mod).toBe(5);
    expect(s.total).toBe(s.base + 5);
  });
  it('prefers the profile version map over the company row', () => {
    const comps = [comp('company', { affinity: { linear: 3 } })];
    expect(affinityFor('linear', 1, comps)).toBe(3);
    expect(affinityFor('figma', 2, comps)).toBe(2);
  });
});

describe('dealbreakers: no bypass for anyone', () => {
  it('max affinity does not rescue an onsite role', () => {
    const s = computeScore(all(5), { workplace: 'onsite' }, rubric, REMOTE_ONLY, 5);
    expect(s.verdict).toBe('archived');
    expect(s.archive_reason).toBe('dealbreaker');
    expect(s.dealbreakers.hits).toContain('remote_required');
  });
  it('hybrid without remote option is a hit; unknown is a verify flag only', () => {
    expect(evaluateDealbreakers({ workplace: 'hybrid' }, REMOTE_ONLY).hits).toEqual(['remote_required']);
    expect(evaluateDealbreakers({ workplace: 'hybrid', remote_ok: true }, REMOTE_ONLY).hits).toEqual([]);
    const u = evaluateDealbreakers({ workplace: 'unspecified' }, REMOTE_ONLY);
    expect(u.hits).toEqual([]);
    expect(u.verify).toEqual(['remote']);
  });
  it('comp below floor is a gate only when the profile marks it hard', () => {
    const soft = [comp('terms', { comp_floor: 200000 })];
    const hard = [comp('terms', { comp_floor: 200000, comp_floor_hard: true })];
    expect(evaluateDealbreakers({ comp_max: 150000 }, soft).hits).toEqual([]);
    expect(evaluateDealbreakers({ comp_max: 150000 }, hard).hits).toEqual(['comp_floor']);
    expect(evaluateDealbreakers({}, hard).verify).toEqual(['comp']);
  });
  it('judged hard nos from the skill gate', () => {
    expect(computeScore(all(5), { dealbreaker_hits: ['ad tech'] }, rubric, [], 0).archive_reason).toBe('dealbreaker');
  });
  it('below green archives with below_threshold', () => {
    expect(computeScore(all(3), {}, rubric, [], 0).archive_reason).toBe('below_threshold');
  });
});

describe('rubric from the profile version', () => {
  it('normalizes to 100', () => {
    const w = normalizeWeights({ c1: 1, c2: 1, c3: 1 }, { c1: 0, c2: 0, c3: 0, c4: 0, c5: 0, c6: 0, c7: 0, c8: 0, c9: 0 });
    expect(Object.values(w).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
    expect(normalizeWeights({})).toEqual(V1_WEIGHTS);
  });
  it('reads criterion_weights from components and falls back per criterion', () => {
    const comps = [comp('team', { criterion_weights: { c1: 30 } }), comp('craft', { criterion_weights: { C9: 20 } })];
    expect(profileCriterionWeights(comps)).toEqual({ c1: 30, c9: 20 });
    const r = rubricFor({ config: DEFAULT_CONFIG, profileVersionId: 'pv_x', components: comps });
    expect(r.weights_source).toBe('profile');
    expect(r.weights.c1).toBeGreaterThan(r.weights.c2);
    const snap = rubricSnapshot(r);
    expect(snap).toMatchObject({
      version: 'profile:pv_x',
      profile_version_id: 'pv_x',
      affinity_cap: 5,
      blind: ['c1', 'c2', 'c3', 'c4', 'c9'],
    });
  });
  it('owner component wins a conflict', () => {
    const comps = [comp('growth', { criterion_weights: { c1: 99 } }), comp('team', { criterion_weights: { c1: 10 } })];
    expect(profileCriterionWeights(comps).c1).toBe(10);
  });
});

describe('per-company cap', () => {
  const c = (id: string, total: number, found = '2026-10-01') => ({ role_id: id, total, found_at: found });
  it('keeps the top N, holds the rest, ties go to the earlier find', () => {
    const alloc = allocateCompanySlots([c('a', 80), c('b', 90), c('c', 85), c('d', 85, '2026-09-01')], 3);
    expect(alloc).toEqual({ active: ['b', 'd', 'c'], held: ['a'] });
  });
  it('promotes a held role when a slot frees', () => {
    const current = new Map<string, 'active' | 'held'>([
      ['b', 'active'],
      ['c', 'held'],
    ]);
    expect(capTransitions(current, allocateCompanySlots([c('b', 90), c('c', 80)], 3))).toEqual([
      { role_id: 'c', from: 'held', to: 'active' },
    ]);
  });
});

describe('scout source mix', () => {
  const q = (kind: ScoutQuery['kind'], company?: string): ScoutQuery => ({ kind, company, query: `${kind}:${company ?? Math.random()}` });
  it('caps watchlist queries at the share', () => {
    expect(maxWatchlist(4, 0.34)).toBe(2);
    expect(maxWatchlist(0, 0.34)).toBe(0);
    const plan = planSourceMix(
      [q('watchlist', 'a'), q('watchlist', 'b'), q('watchlist', 'c'), q('open'), q('open'), q('open'), q('open')],
      0.34,
    );
    expect(plan.watchlist_share).toBeLessThanOrEqual(0.34);
    expect(plan.queries.filter((x) => x.kind === 'watchlist').map((x) => x.company)).toEqual(['a', 'b']);
    expect(plan.dropped.map((x) => x.company)).toEqual(['c']);
  });
  it('one query per watchlist company', () => {
    const plan = planSourceMix([q('watchlist', 'a'), q('watchlist', 'a'), q('open'), q('open'), q('open'), q('open')], 0.34);
    expect(plan.queries.filter((x) => x.kind === 'watchlist')).toHaveLength(1);
  });
  it('watchlist from the Company component', () => {
    expect(watchlistFrom({ watchlist: ['x', 'y'] })).toEqual(['x', 'y']);
    expect(watchlistFrom({ affinity: { a: 1, b: 3, c: -2 } })).toEqual(['b', 'a']);
  });
});
