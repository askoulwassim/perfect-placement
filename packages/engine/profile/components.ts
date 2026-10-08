import {
  COMPONENT_DIFF_IMPACT,
  CRITERIA,
  CRITERION_OWNER,
  type CriterionWeights as CriteriaWeights,
  type Criterion,
  criteriaOwnedBy,
  type Impact,
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  type ProfileComponentKey,
} from '@perfect-placement/contracts';

/*
 * Per-component data schemas moved to packages/contracts in Wave 2 (COMPONENT_DATA_SCHEMAS);
 * re-exported here so lane E code keeps its imports.
 */

export {
  COMPONENT_DATA_SCHEMAS,
  type ComponentData,
  CriterionAnchor,
  CriterionWeights,
  CriterionWeights as CriteriaWeights,
  parseComponentData,
  StoryItem,
  StoryRole,
  safeParseComponentData,
  V1Section,
} from '@perfect-placement/contracts';

// ---------------------------------------------------------------------------
// Criterion ownership: which component carries each rubric criterion's weight.
// ---------------------------------------------------------------------------

/**
 * Each of C1..C9 is owned by exactly one component (CRITERION_OWNER, contracts). A weighted
 * component's `weight` column = sum of its owned criteria weights / 100. C6 (comp) is owned
 * by Terms, a filter: its weight lives in Terms.data_json.criterion_weights and the column stays null.
 */
export { CRITERION_OWNER, criteriaOwnedBy } from '@perfect-placement/contracts';

/** Neutral prior when nothing is stated. Sums to 100. */
export const NEUTRAL_WEIGHTS: Record<Criterion, number> = { c1: 12, c2: 12, c3: 11, c4: 11, c5: 11, c6: 11, c7: 11, c8: 11, c9: 10 };

/**
 * Collect the rubric weights (sum 100) from a set of components.
 * Missing criteria fall back to: the owning component's `weight` spread evenly, else NEUTRAL_WEIGHTS.
 * Lane F reads this to build the score rubric for a profile version.
 */
export function rubricWeights(
  components: ReadonlyArray<{ key: ProfileComponentKey; weight: number | null; data_json: Record<string, unknown> }>,
): Record<Criterion, number> {
  const out = {} as Record<Criterion, number>;
  for (const c of CRITERIA) {
    const owner = components.find((p) => p.key === CRITERION_OWNER[c]);
    const stated = (owner?.data_json.criterion_weights as CriteriaWeights | undefined)?.[c];
    if (typeof stated === 'number') out[c] = stated;
    else if (owner?.weight != null) out[c] = (owner.weight * 100) / criteriaOwnedBy(owner.key).length;
    else out[c] = NEUTRAL_WEIGHTS[c];
  }
  return normalizeWeights(out);
}

/** Scale to sum 100 and round with largest remainder so the integers sum to exactly 100. */
export function normalizeWeights(w: Record<Criterion, number>): Record<Criterion, number> {
  const total = CRITERIA.reduce((s, c) => s + Math.max(0, w[c]), 0);
  if (total <= 0) return { ...NEUTRAL_WEIGHTS };
  const raw = CRITERIA.map((c) => ({ c, v: (Math.max(0, w[c]) * 100) / total }));
  const floors = raw.map((r) => ({ c: r.c, v: Math.floor(r.v), rem: r.v - Math.floor(r.v) }));
  let left = 100 - floors.reduce((s, r) => s + r.v, 0);
  const order = [...floors].sort((a, b) => b.rem - a.rem || CRITERIA.indexOf(a.c) - CRITERIA.indexOf(b.c));
  for (const r of order) {
    if (left <= 0) break;
    r.v += 1;
    left -= 1;
  }
  return Object.fromEntries(floors.map((r) => [r.c, r.v])) as Record<Criterion, number>;
}

/** Split rubric weights into per-component `criterion_weights` + the `weight` column value. */
export function weightsByComponent(
  weights: Record<Criterion, number>,
): Record<ProfileComponentKey, { criterion_weights: CriteriaWeights; weight: number | null }> {
  const out = {} as Record<ProfileComponentKey, { criterion_weights: CriteriaWeights; weight: number | null }>;
  for (const key of PROFILE_COMPONENT_KEYS) {
    const owned = criteriaOwnedBy(key);
    const cw: CriteriaWeights = {};
    for (const c of owned) cw[c] = weights[c];
    const kind = PROFILE_COMPONENT_KIND[key];
    const sum = owned.reduce((s, c) => s + weights[c], 0);
    out[key] = { criterion_weights: cw, weight: kind === 'weighted' ? Math.round(sum * 100) / 10000 : null };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Impact tiers for profile diffs (wave1-decisions #14, #24).
// ---------------------------------------------------------------------------

/**
 * COMPONENT_DIFF_IMPACT (contracts): filters (work_mode, terms, dealbreakers) high; weighted and asset
 * (story, voice, network) medium. Hard exclusions (Dealbreakers, a comp floor change) are always human:
 * see `isHardHumanDiff` in profile-ops.ts.
 */
export function impactForComponent(key: ProfileComponentKey): Impact {
  return COMPONENT_DIFF_IMPACT[PROFILE_COMPONENT_KIND[key]];
}
