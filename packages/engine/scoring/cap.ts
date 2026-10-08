/*
 * Per-company cap (blueprint "Scoring v2"): the top `company_active_cap` roles per company stay `active`,
 * the rest go to `held` (held_reason company_cap). When a slot frees, the best held role is promoted.
 * Only `active` and `held` roles take part; on-deck and later are never touched by the cap.
 */

export interface CapCandidate {
  role_id: string;
  total: number;
  /** ISO; earlier wins a tie (it was found first). */
  found_at: string;
}

export interface CapAllocation {
  active: string[];
  held: string[];
}

export function rankCandidates<T extends CapCandidate>(cands: readonly T[]): T[] {
  return [...cands].sort((a, b) => b.total - a.total || a.found_at.localeCompare(b.found_at) || a.role_id.localeCompare(b.role_id));
}

/** Pure: which of a company's eligible roles are active vs held. */
export function allocateCompanySlots(cands: readonly CapCandidate[], cap: number): CapAllocation {
  const ranked = rankCandidates(cands);
  const n = Math.max(1, Math.floor(cap));
  return { active: ranked.slice(0, n).map((c) => c.role_id), held: ranked.slice(n).map((c) => c.role_id) };
}

export interface CapTransition {
  role_id: string;
  from: 'active' | 'held';
  to: 'active' | 'held';
}

/** Transitions needed to go from current statuses to the allocation. */
export function capTransitions(current: ReadonlyMap<string, 'active' | 'held'>, alloc: CapAllocation): CapTransition[] {
  const out: CapTransition[] = [];
  for (const id of alloc.active) {
    const from = current.get(id);
    if (from === 'held') out.push({ role_id: id, from, to: 'active' });
  }
  for (const id of alloc.held) {
    const from = current.get(id);
    if (from === 'active') out.push({ role_id: id, from, to: 'held' });
  }
  return out;
}
