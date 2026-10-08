import {
  CRITERIA,
  type Criterion,
  type Impact,
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  type ProfileComponentKey,
} from '@perfect-placement/contracts';
import { z } from 'zod';

/*
 * Per-component data schemas (the shape of profile_component.data_json).
 *
 * Every schema is a loose object: known fields are typed, unknown fields are kept
 * (nothing a converter or an LLM diff adds is silently dropped). Contract request:
 * these move into packages/contracts in Wave 2 (CONTRACT_CHANGES.md, lane E).
 */

const Text = z.string();
const TextList = z.array(z.string());

/** Criterion weights owned by a component (see CRITERION_OWNER). Points out of 100. */
export const CriteriaWeights = z.partialRecord(z.enum(CRITERIA), z.number().min(0).max(100));
export type CriteriaWeights = z.infer<typeof CriteriaWeights>;

/** Raw v1 text kept verbatim by the converter so nothing is dropped. */
export const V1Section = z.object({ source: z.string(), heading: z.string(), text: z.string() });
export type V1Section = z.infer<typeof V1Section>;

/** Rubric anchors for a criterion (1 poor, 3 ok, 5 ideal). */
export const CriterionAnchor = z.object({
  id: z.enum(CRITERIA),
  label: z.string(),
  weight: z.number().optional(),
  anchors: z.record(z.string(), z.string()).optional(),
});

/** Fields every component may carry. */
const common = {
  criteria_weights: CriteriaWeights.optional(),
  criteria: z.array(CriterionAnchor).optional(),
  notes: TextList.optional(),
  open_questions: TextList.optional(),
  v1_sections: z.array(V1Section).optional(),
};

export const StoryRole = z.looseObject({
  company: Text,
  title: Text,
  dates: Text.optional(),
  summary: Text.optional(),
  bullets: TextList.default([]),
});
export const StoryItem = z.looseObject({
  title: Text,
  status: Text.optional(),
  themes: TextList.default([]),
  situation: Text.optional(),
  task: Text.optional(),
  action: Text.optional(),
  result: Text.optional(),
  confirm: Text.optional(),
});

export const COMPONENT_DATA_SCHEMAS = {
  story: z.looseObject({
    ...common,
    headline: Text.optional(),
    years: z.number().nonnegative().optional(),
    summary: Text.optional(),
    contact: z.record(z.string(), z.string()).optional(),
    roles: z.array(StoryRole).optional(),
    wins: TextList.optional(),
    stories: z.array(StoryItem).optional(),
    skills: TextList.optional(),
    education: TextList.optional(),
    recognition: TextList.optional(),
    gaps: TextList.optional(),
  }),
  craft: z.looseObject({
    ...common,
    functions: TextList.optional(),
    level: Text.optional(),
    /** ic | lead | either (fixtures use 'lead'). */
    mode: Text.optional(),
    adjacent: TextList.optional(),
    explore: TextList.optional(),
    facing: Text.optional(),
    target: Text.optional(),
  }),
  domain: z.looseObject({
    ...common,
    ranked: TextList.optional(),
    avoid: TextList.optional(),
  }),
  work_mode: z.looseObject({
    ...common,
    modes: TextList.optional(),
    locations: TextList.optional(),
    home_location: Text.optional(),
    travel_max_pct: z.number().min(0).max(100).optional(),
    relocation: Text.optional(),
  }),
  terms: z.looseObject({
    ...common,
    comp_floor: z.number().nonnegative().optional(),
    comp_target: z.number().nonnegative().optional(),
    comp_target_max: z.number().nonnegative().optional(),
    comp_penalty_below: z.number().nonnegative().optional(),
    currency: Text.optional(),
    equity: Text.optional(),
  }),
  company: z.looseObject({
    ...common,
    stages: TextList.optional(),
    size: Text.optional(),
    mission: TextList.optional(),
    /** company slug -> -5..+5 (decisions.md #5: capped nudge, never a dealbreaker bypass). */
    affinity: z.record(z.string(), z.number().int().min(-5).max(5)).optional(),
    dream_companies: TextList.optional(),
    reference_companies: TextList.optional(),
    watchlist: TextList.optional(),
  }),
  team: z.looseObject({
    ...common,
    proximity: Text.optional(),
    prefers_small_teams: z.boolean().optional(),
    archetypes: TextList.optional(),
  }),
  growth: z.looseObject({
    ...common,
    scope_ceiling: Text.optional(),
    trajectory: Text.optional(),
  }),
  dealbreakers: z.looseObject({
    ...common,
    hard_nos: TextList.default([]),
    rules: z.array(z.looseObject({ text: Text, auto_archive: z.boolean().optional() })).optional(),
  }),
  voice: z.looseObject({
    ...common,
    style: Text.optional(),
    rules: TextList.optional(),
    positioning: Text.optional(),
    differentiators: TextList.optional(),
    proof_points: z.array(z.looseObject({ claim: Text, evidence: Text })).optional(),
    pitches: z.record(z.string(), z.string()).optional(),
    standard_answers: z.record(z.string(), z.string()).optional(),
    samples: TextList.optional(),
  }),
  network: z.looseObject({
    ...common,
    warm_companies: TextList.optional(),
  }),
} as const satisfies Record<ProfileComponentKey, z.ZodType>;

export type ComponentData<K extends ProfileComponentKey> = z.infer<(typeof COMPONENT_DATA_SCHEMAS)[K]>;

/** Validate (and default) a component's data. Throws ZodError on invalid data. */
export function parseComponentData(key: ProfileComponentKey, data: unknown): Record<string, unknown> {
  return COMPONENT_DATA_SCHEMAS[key].parse(data) as Record<string, unknown>;
}

export function safeParseComponentData(key: ProfileComponentKey, data: unknown) {
  return COMPONENT_DATA_SCHEMAS[key].safeParse(data);
}

// ---------------------------------------------------------------------------
// Criterion ownership: which component carries each rubric criterion's weight.
// ---------------------------------------------------------------------------

/**
 * Each of C1..C9 is owned by exactly one component. A weighted component's
 * `weight` column = sum of its owned criteria weights / 100. C6 (comp) is owned
 * by Terms, a filter: its weight lives in Terms.data_json.criteria_weights and
 * the column stays null (contract: weight is null for filters).
 */
export const CRITERION_OWNER: Record<Criterion, ProfileComponentKey> = {
  c1: 'team',
  c2: 'company',
  c3: 'craft',
  c4: 'domain',
  c5: 'domain',
  c6: 'terms',
  c7: 'team',
  c8: 'growth',
  c9: 'craft',
};

export function criteriaOwnedBy(key: ProfileComponentKey): Criterion[] {
  return CRITERIA.filter((c) => CRITERION_OWNER[c] === key);
}

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
    const stated = (owner?.data_json.criteria_weights as CriteriaWeights | undefined)?.[c];
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

/** Split rubric weights into per-component `criteria_weights` + the `weight` column value. */
export function weightsByComponent(
  weights: Record<Criterion, number>,
): Record<ProfileComponentKey, { criteria_weights: CriteriaWeights; weight: number | null }> {
  const out = {} as Record<ProfileComponentKey, { criteria_weights: CriteriaWeights; weight: number | null }>;
  for (const key of PROFILE_COMPONENT_KEYS) {
    const owned = criteriaOwnedBy(key);
    const cw: CriteriaWeights = {};
    for (const c of owned) cw[c] = weights[c];
    const kind = PROFILE_COMPONENT_KIND[key];
    const sum = owned.reduce((s, c) => s + weights[c], 0);
    out[key] = { criteria_weights: cw, weight: kind === 'weighted' ? Math.round(sum * 100) / 10000 : null };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Impact tiers for profile diffs (decisions.md #4; lane E brief).
// ---------------------------------------------------------------------------

/**
 * - filter components (work_mode, terms, dealbreakers): high. Never auto-applied.
 * - weighted components: medium (auto + 24h undo when confident).
 * - asset components (story, voice, network): low (internal inputs to drafting;
 *   every external use of them still ends at a human: Open portal / Gmail draft).
 */
export function impactForComponent(key: ProfileComponentKey): Impact {
  const kind = PROFILE_COMPONENT_KIND[key];
  if (kind === 'filter') return 'high';
  if (kind === 'weighted') return 'medium';
  return 'low';
}

/** Hard guard: filters and dealbreakers can only change through a human. */
export function isHumanOnlyComponent(key: ProfileComponentKey): boolean {
  return PROFILE_COMPONENT_KIND[key] === 'filter';
}
