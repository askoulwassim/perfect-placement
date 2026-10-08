import {
  type Answer,
  DEFAULT_CONFIG,
  IMPACTS,
  type Impact,
  type PolicyOutcome,
  type Question,
  type Thresholds,
} from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import {
  canUndo,
  confidenceBand,
  decide,
  effectiveImpact,
  effectiveThresholds,
  finalOutcome,
  secondOpinionAgrees,
  undoUntil,
} from './policy.js';

const T: Thresholds = DEFAULT_CONFIG.policy; // auto 0.90, second_opinion 0.70, undo 24h

/**
 * The wave1-decisions #24 grid, written out by hand, so the test does not just echo POLICY_GRID.
 * High row: the contract grid says auto_undo when confident, but `decide()` keeps high impact
 * human until Phase 2 wires the hard exclusions (isHardHuman) with the diff component.
 */
const EXPECTED: Record<Impact, { confident: PolicyOutcome; middle: PolicyOutcome; low: PolicyOutcome }> = {
  low: { confident: 'auto', middle: 'auto', low: 'auto_undo' },
  medium: { confident: 'auto', middle: 'auto_second', low: 'human' },
  high: { confident: 'human', middle: 'human', low: 'human' },
};

/** Representative p per band, including both edges of each band. */
const P_SAMPLES = {
  confident: [1, 0.97, 0.9],
  middle: [0.8999, 0.8, 0.7],
  low: [0.6999, 0.5, 0.1, 0],
} as const;

describe('decide(): every cell of the grid', () => {
  const rows = IMPACTS.flatMap((impact) =>
    (Object.keys(P_SAMPLES) as (keyof typeof P_SAMPLES)[]).flatMap((band) =>
      P_SAMPLES[band].map((p) => ({ impact, band, p, expected: EXPECTED[impact][band] })),
    ),
  );
  it('covers 3 impacts x 3 bands', () => {
    expect(new Set(rows.map((r) => `${r.impact}/${r.band}`)).size).toBe(9);
  });
  it.each(rows)('$impact impact, p=$p ($band) -> $expected', ({ impact, p, band, expected }) => {
    expect(confidenceBand(p, T)).toBe(band);
    expect(decide({ p }, impact, T)).toBe(expected);
  });
});

describe('thresholds and overrides', () => {
  it('per-kind override from config (freshness.closed auto = 0.92)', () => {
    const t = effectiveThresholds(DEFAULT_CONFIG, 'freshness.closed');
    expect(t.auto).toBe(0.92);
    expect(decide({ p: 0.91 }, 'medium', t)).toBe('auto_second');
    expect(decide({ p: 0.91 }, 'medium', effectiveThresholds(DEFAULT_CONFIG, 'inbox.classify'))).toBe('auto');
    expect(decide({ p: 0.92 }, 'medium', t)).toBe('auto');
  });

  it('per-call override wins over the kind override', () => {
    const t = effectiveThresholds(DEFAULT_CONFIG, 'freshness.closed', { auto: 0.99, second_opinion: 0.5 });
    expect(t).toEqual({ auto: 0.99, second_opinion: 0.5, undo_hours: 24 });
    expect(decide({ p: 0.95 }, 'medium', t)).toBe('auto_second');
    expect(decide({ p: 0.55 }, 'medium', t)).toBe('auto_second');
    expect(decide({ p: 0.49 }, 'medium', t)).toBe('human');
  });

  it('high impact is human even with thresholds of zero', () => {
    const t = { auto: 0, second_opinion: 0, undo_hours: 1 };
    expect(decide({ p: 1 }, 'high', t)).toBe('human');
  });

  it.each([
    ['apply.submit', 'low', 'high'],
    ['apply.submit', 'medium', 'high'],
    ['profile.apply_diff', 'low', 'medium'],
    ['profile.apply_diff', 'high', 'high'],
    ['roles.criterion', 'low', 'low'],
    ['people.classify', 'low', 'low'],
    ['freshness.closed', 'low', 'medium'],
  ] as const)('impact floor: %s asked as %s -> %s', (kind, asked, expected) => {
    expect(effectiveImpact(kind, asked)).toBe(expected);
  });
});

describe('second opinion', () => {
  const choice: Question = { id: 'who', type: 'choice', instructions: '', options: ['a', 'b', 'other'] };
  const score: Question = { id: 'c1', type: 'score', instructions: '', min: 1, max: 5 };
  const noulli: Question = { id: 'open', type: 'noulli', instructions: '' };
  const a = (value: Answer['value'], p: number, id = 'x'): Answer => ({ id, value, p });

  it.each([
    ['same choice, p 0.70', choice, a('a', 0.8), a('a', 0.7), true],
    ['same choice, case differs', choice, a('a', 0.8), a('A', 0.75), true],
    ['same choice, p 0.69', choice, a('a', 0.8), a('a', 0.69), false],
    ['different choice', choice, a('a', 0.8), a('b', 0.99), false],
    ['same score level', score, a(4, 0.8), a(4, 0.71), true],
    ['score off by one', score, a(4, 0.8), a(3, 0.95), false],
    ['same noulli', noulli, a(true, 0.8), a(true, 0.9), true],
    ['opposite noulli', noulli, a(true, 0.8), a(false, 0.9), false],
    ['no second answer', noulli, a(true, 0.8), undefined, false],
  ] as const)('%s', (_name, q, primary, second, agrees) => {
    expect(secondOpinionAgrees(q, primary, second)).toBe(agrees);
  });

  it.each([
    ['auto_second', true, 'auto_second'],
    ['auto_second', false, 'human'],
    ['auto', false, 'auto'],
    ['auto_undo', false, 'auto_undo'],
    ['human', true, 'human'],
  ] as const)('finalOutcome(%s, agrees=%s) -> %s', (decided, agrees, expected) => {
    expect(finalOutcome(decided, agrees)).toBe(expected);
  });
});

describe('undo window', () => {
  const now = new Date('2026-10-08T12:00:00.000Z');
  const until = undoUntil(now, T);
  it('is undo_hours after the decision', () => {
    expect(until).toBe('2026-10-09T12:00:00.000Z');
    expect(undoUntil(now, { ...T, undo_hours: 2 })).toBe('2026-10-08T14:00:00.000Z');
  });
  const d = { policy_outcome: 'auto_undo' as const, status: 'applied' as const, undo_until: until };
  it.each([
    ['inside the window', d, '2026-10-09T11:59:59.000Z', true],
    ['at the boundary', d, '2026-10-09T12:00:00.000Z', true],
    ['after the window', d, '2026-10-09T12:00:01.000Z', false],
    ['already undone', { ...d, status: 'undone' as const }, '2026-10-08T13:00:00.000Z', false],
    ['plain auto', { ...d, policy_outcome: 'auto' as const }, '2026-10-08T13:00:00.000Z', false],
    ['auto_second', { ...d, policy_outcome: 'auto_second' as const }, '2026-10-08T13:00:00.000Z', false],
    ['no window', { ...d, undo_until: null }, '2026-10-08T13:00:00.000Z', false],
  ] as const)('%s -> %s', (_n, dec, at, expected) => {
    expect(canUndo(dec, new Date(at))).toBe(expected);
  });
});
