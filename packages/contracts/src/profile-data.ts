import { z } from 'zod';
import { CRITERIA, type ProfileComponentKey } from './enums.js';

/*
 * Per-component data schemas: the shape of `profile_component.data_json` by `key`
 * (Wave 2, moved here from packages/engine/profile/components.ts; lane E request).
 *
 * Every schema is a loose object: known fields are typed, unknown fields are kept
 * (nothing a converter or an LLM diff adds is silently dropped).
 */

const Text = z.string();
const TextList = z.array(z.string());

/** Criterion weights owned by a component (see CRITERION_OWNER). Points out of 100. */
export const CriterionWeights = z.partialRecord(z.enum(CRITERIA), z.number().min(0).max(100));
export type CriterionWeights = z.infer<typeof CriterionWeights>;

/** Rubric anchors for a criterion (1 poor, 3 ok, 5 ideal). */
export const CriterionAnchor = z.object({
  id: z.enum(CRITERIA),
  label: z.string(),
  weight: z.number().optional(),
  anchors: z.record(z.string(), z.string()).optional(),
});

/** Fields every component may carry. */
const common = {
  /** Owned criterion weights, points of 100 (CRITERION_OWNER). Read by lane F's rubric. */
  criterion_weights: CriterionWeights.optional(),
  criteria: z.array(CriterionAnchor).optional(),
  notes: TextList.optional(),
  open_questions: TextList.optional(),
  /** Added (#38): dictated answers as spoken, by question id (provenance; the cleaned text is the value). */
  dictated: z.record(z.string(), z.string()).optional(),
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

/** Voice writing samples kept by onboarding (outreach voice). */
export const VOICE_SAMPLES_MAX = 5;
export const VOICE_SAMPLE_MAX_CHARS = 1500;

export const COMPONENT_DATA_SCHEMAS = {
  story: z.looseObject({
    ...common,
    headline: Text.optional(),
    years: z.number().nonnegative().optional(),
    /**
     * Added (#38): where `years` came from. `stated` (in the resume), `from dates` (role dates, not yet
     * confirmed), `confirmed` (the user confirmed it). Never guessed; unconfirmed years are not a source.
     */
    years_basis: z.enum(['stated', 'from dates', 'confirmed']).optional(),
    /** Added (#38): the kept source resume: extracted text (vault markdown) and the original upload. */
    source_path: Text.optional(),
    source_file: Text.optional(),
    /** Added (#38): who extracted the facts (`agent` run or the instant `preview`). */
    extracted_by: z.enum(['agent', 'preview']).optional(),
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
    /** ic | lead | either. */
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
    /** Scoring: exactly ['remote'] means remote is required (lane F dealbreaker). */
    modes: TextList.optional(),
    locations: TextList.optional(),
    home_location: Text.optional(),
    travel_max_pct: z.number().min(0).max(100).optional(),
    relocation: Text.optional(),
  }),
  terms: z.looseObject({
    ...common,
    comp_floor: z.number().nonnegative().optional(),
    /** true = comp below the floor is a dealbreaker; default false = C6 penalty only (wave1-decisions #12). */
    comp_floor_hard: z.boolean().optional(),
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
    /** company slug -> -5..+5 (decisions.md #5: capped nudge, never a dealbreaker bypass). Dream companies default to DREAM_AFFINITY. */
    affinity: z.record(z.string(), z.number().int().min(-5).max(5)).optional(),
    dream_companies: TextList.optional(),
    reference_companies: TextList.optional(),
    /** Company slugs the scout checks directly. */
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
    /**
     * Writing samples (style exemplars for the outreach writer: tone, rhythm, phrasing; never facts).
     * Onboarding appends (voice.sample), up to VOICE_SAMPLES_MAX of at most VOICE_SAMPLE_MAX_CHARS each.
     */
    samples: TextList.optional(),
    /** Email sign-off in the user's voice, e.g. "Thanks,\nAlex". Default: "Thanks," plus the first name. */
    signoff: Text.optional(),
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
