import { afterEach, describe, expect, it, vi } from 'vitest';
import { heldStacks, loadLaneSorts, RIVER_SORT_KEY, saveLaneSorts, sortLane } from './river';
import type { RoleView } from './role';

const v = (id: string, total: number | null, found: string, co = id): RoleView =>
  ({
    role: { id, found_at: found, status: 'active' },
    company: { id: co, name: co },
    latest_score: total == null ? null : { total },
  }) as unknown as RoleView;

const ids = (xs: RoleView[]) => xs.map((x) => x.role.id);

describe('sortLane (#104)', () => {
  const lane = [
    v('a', null, '2026-01-01T00:00:00Z'),
    v('b', 80, '2026-01-01T00:00:00Z'),
    v('c', null, '2026-03-01T00:00:00Z'),
    v('d', 92, '2026-01-02T00:00:00Z'),
    v('e', 80, '2026-02-01T00:00:00Z'),
    v('f', 80, '2026-02-01T00:00:00Z'),
  ];

  it('sorts by score desc, unscored last by found date newest first, ties by found then id', () => {
    expect(ids(sortLane(lane))).toEqual(['d', 'e', 'f', 'b', 'c', 'a']);
    expect(ids(sortLane(lane, 'score'))).toEqual(['d', 'e', 'f', 'b', 'c', 'a']);
  });

  it('is stable regardless of input order and does not mutate it', () => {
    const copy = [...lane];
    expect(ids(sortLane([...lane].reverse()))).toEqual(ids(sortLane(lane)));
    expect(lane).toEqual(copy);
  });

  it('newest sorts by found date desc, then score, then id', () => {
    expect(ids(sortLane(lane, 'newest'))).toEqual(['c', 'e', 'f', 'd', 'b', 'a']);
  });

  it('keeps zero scores above unscored', () => {
    expect(ids(sortLane([v('x', null, '2026-05-01T00:00:00Z'), v('y', 0, '2026-01-01T00:00:00Z')]))).toEqual(['y', 'x']);
  });
});

describe('heldStacks (#104)', () => {
  it('puts a company held stack on its best tile in the sorted lane', () => {
    const active = sortLane([
      v('lo', 70, '2026-01-01T00:00:00Z', 'acme'),
      v('hi', 90, '2026-01-01T00:00:00Z', 'acme'),
      v('z', 85, '2026-01-01T00:00:00Z', 'zeta'),
    ]);
    const held = [v('h1', 60, '2026-01-01T00:00:00Z', 'acme'), v('h2', 50, '2026-01-01T00:00:00Z', 'acme')];
    const m = heldStacks(active, held);
    expect([...m.entries()]).toEqual([['hi', 2]]);
  });
});

describe('lane sort storage (#104)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('round-trips and ignores junk values', () => {
    saveLaneSorts({ active: 'newest' });
    expect(loadLaneSorts()).toEqual({ active: 'newest' });
    window.localStorage.setItem(RIVER_SORT_KEY, JSON.stringify({ active: 'bogus', held: 'score' }));
    expect(loadLaneSorts()).toEqual({ held: 'score' });
    window.localStorage.setItem(RIVER_SORT_KEY, '{not json');
    expect(loadLaneSorts()).toEqual({});
  });

  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadLaneSorts()).toEqual({});
    expect(() => saveLaneSorts({ active: 'newest' })).not.toThrow();
  });
});
