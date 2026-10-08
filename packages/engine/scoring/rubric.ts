import {
  BLIND_CRITERIA,
  CRITERIA,
  CRITERION_OWNER,
  type Criterion,
  type PolicyConfig,
  type ProfileComponent,
  type ScoreScale,
} from '@perfect-placement/contracts';

/*
 * Rubric = the weights + bands + scale a score was computed with.
 * Weights come from the profile version (decisions.md #5, blueprint "Scoring v2").
 * Every score row stores `rubricSnapshot(...)` in `rubric_json`.
 */

export type Weights = Record<Criterion, number>;

/**
 * Total formula.
 * - `v1`: total = round(sum(c_i * w_i) / 5). Range 20..100. Same as v1 scorer.py; bands 75/55 were calibrated on it.
 * - `zero_based`: total = round(sum(w_i * (c_i - 1) / 4)). Range 0..100 (Wave 0 fixtures used it; Wave 2 fixtures are v1).
 */
export { SCORE_SCALES as SCALES } from '@perfect-placement/contracts';
export type Scale = ScoreScale;

export interface Rubric {
  version: string;
  weights: Weights;
  scale: Scale;
  green_min: number;
  yellow_min: number;
  affinity_cap: number;
  company_active_cap: number;
  /** Where the weights came from. */
  weights_source: 'profile' | 'default';
  profile_version_id: string | null;
}

/** v1 rubric.json weights (C1..C9), the prior until calibration writes profile weights. */
export const V1_WEIGHTS: Weights = { c1: 15, c2: 15, c3: 12, c4: 12, c5: 10, c6: 12, c7: 8, c8: 8, c9: 8 };

/**
 * Which profile component owns which criterion's weight: CRITERION_OWNER in contracts (Wave 2).
 * Lane E stores calibrated weights as `data_json.criterion_weights: { c1: 15, ... }` on the owning component.
 */
export { CRITERION_OWNER };

/** Scale weights so they sum to exactly 100 (largest-remainder rounding to 0.01). */
export function normalizeWeights(raw: Partial<Record<Criterion, number>>, fallback: Weights = V1_WEIGHTS): Weights {
  const merged = {} as Weights;
  for (const k of CRITERIA) {
    const v = raw[k];
    merged[k] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback[k];
  }
  const sum = CRITERIA.reduce((s, k) => s + merged[k], 0);
  if (sum <= 0) return { ...fallback };
  const cents = CRITERIA.map((k) => ({ k, exact: (merged[k] / sum) * 10000 }));
  const floored = cents.map((c) => ({ ...c, v: Math.floor(c.exact) }));
  let left = 10000 - floored.reduce((s, c) => s + c.v, 0);
  for (const c of [...floored].sort((a, b) => b.exact - Math.floor(b.exact) - (a.exact - Math.floor(a.exact)))) {
    if (left <= 0) break;
    c.v += 1;
    left -= 1;
  }
  const out = {} as Weights;
  for (const c of floored) out[c.k] = c.v / 100;
  return out;
}

/** Accepts `C1`/`c1` keyed maps (v1 rubric.json uses upper case). */
export function readWeights(obj: unknown): Partial<Record<Criterion, number>> {
  const out: Partial<Record<Criterion, number>> = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = k.toLowerCase() as Criterion;
    if ((CRITERIA as readonly string[]).includes(key) && typeof v === 'number') out[key] = v;
  }
  return out;
}

/** Criterion weights carried by a profile version's components, merged. Empty if none (pre-calibration). */
export function profileCriterionWeights(components: readonly ProfileComponent[]): Partial<Record<Criterion, number>> {
  const out: Partial<Record<Criterion, number>> = {};
  // Owner component wins over a stray value on another component.
  const ordered = [...components].sort((a, b) => ownsAny(b) - ownsAny(a));
  for (const c of ordered) {
    const w = readWeights((c.data_json as Record<string, unknown>).criterion_weights);
    for (const [k, v] of Object.entries(w) as Array<[Criterion, number]>) {
      if (out[k] === undefined || CRITERION_OWNER[k] === c.key) out[k] = v;
    }
  }
  return out;
}

function ownsAny(c: ProfileComponent): number {
  return Object.values(CRITERION_OWNER).includes(c.key) ? 1 : 0;
}

export interface RubricInput {
  config: PolicyConfig;
  profileVersionId: string | null;
  components: readonly ProfileComponent[];
  scale?: Scale;
}

/** Build the rubric for a profile version. Falls back to v1 weights per missing criterion. */
export function rubricFor({ config, profileVersionId, components, scale = 'v1' }: RubricInput): Rubric {
  const fromProfile = profileCriterionWeights(components);
  const hasProfile = Object.keys(fromProfile).length > 0;
  return {
    version: profileVersionId ? `profile:${profileVersionId}` : 'default:v1',
    weights: normalizeWeights(fromProfile),
    scale,
    green_min: config.scoring.green_min,
    yellow_min: config.scoring.yellow_min,
    affinity_cap: config.scoring.affinity_cap,
    company_active_cap: config.scoring.company_active_cap,
    weights_source: hasProfile ? 'profile' : 'default',
    profile_version_id: profileVersionId,
  };
}

/** What goes into `score.rubric_json`. */
export function rubricSnapshot(r: Rubric): Record<string, unknown> {
  return {
    version: r.version,
    weights: { ...r.weights },
    scale: r.scale,
    bands: { green_min: r.green_min, yellow_min: r.yellow_min },
    affinity_cap: r.affinity_cap,
    company_active_cap: r.company_active_cap,
    weights_source: r.weights_source,
    profile_version_id: r.profile_version_id,
    formula:
      r.scale === 'v1'
        ? 'total = clamp(round(sum(c_i * w_i) / 5) + affinity_mod, 0, 100)'
        : 'total = clamp(round(sum(w_i * (c_i - 1) / 4)) + affinity_mod, 0, 100)',
    blind: [...BLIND_CRITERIA],
  };
}
