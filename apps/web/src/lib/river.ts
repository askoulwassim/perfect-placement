import type { RoleStatus } from '@perfect-placement/contracts';
import type { RoleView } from './role';

/** How a River lane is ordered (#104): by latest score total, or newest found first. */
export type LaneSort = 'score' | 'newest';
export type LaneSorts = Partial<Record<RoleStatus, LaneSort>>;

const foundMs = (v: RoleView) => {
  const t = Date.parse(v.role.found_at);
  return Number.isNaN(t) ? 0 : t;
};
const byId = (a: RoleView, b: RoleView) => (a.role.id < b.role.id ? -1 : a.role.id > b.role.id ? 1 : 0);
const byFound = (a: RoleView, b: RoleView) => foundMs(b) - foundMs(a);

/**
 * One lane's order (#104), a pure function the op stays agnostic of.
 * score: latest score total desc, unscored last; then found date (newest first), then id.
 * newest: found date desc, then score desc (unscored last), then id.
 */
export function sortLane(roles: readonly RoleView[], sort: LaneSort = 'score'): RoleView[] {
  const byScore = (a: RoleView, b: RoleView) => {
    const x = a.latest_score?.total;
    const y = b.latest_score?.total;
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x;
  };
  const keys = sort === 'newest' ? [byFound, byScore, byId] : [byScore, byFound, byId];
  return [...roles].sort((a, b) => {
    for (const k of keys) {
      const d = k(a, b);
      if (d !== 0) return d;
    }
    return 0;
  });
}

/**
 * Which tile in a sorted active lane carries a company's "+N held" chip: its best (first) tile,
 * so the stack sits at that tile's score. Returns role id -> held count.
 */
export function heldStacks(sortedActive: readonly RoleView[], held: readonly RoleView[]): Map<string, number> {
  const out = new Map<string, number>();
  const seen = new Set<string>();
  for (const v of sortedActive) {
    if (seen.has(v.company.id)) continue;
    seen.add(v.company.id);
    const n = held.filter((h) => h.company.id === v.company.id).length;
    if (n) out.set(v.role.id, n);
  }
  return out;
}

/** Where a viewer's per-lane sort is kept (localStorage, this browser only). */
export const RIVER_SORT_KEY = 'pp.river.sort';

/** The remembered per-lane sorts, or none when storage is unavailable or holds junk. */
export function loadLaneSorts(): LaneSorts {
  try {
    const raw = window.localStorage.getItem(RIVER_SORT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: LaneSorts = {};
    for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (val === 'score' || val === 'newest') out[k as RoleStatus] = val;
    }
    return out;
  } catch {
    return {};
  }
}

/** Remember the per-lane sorts. Storage may be unavailable: then they last until the app closes. */
export function saveLaneSorts(sorts: LaneSorts): void {
  try {
    window.localStorage.setItem(RIVER_SORT_KEY, JSON.stringify(sorts));
  } catch {
    // private mode or blocked storage
  }
}
