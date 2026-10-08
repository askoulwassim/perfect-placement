import { z } from 'zod';
import { DecisionKind, type Impact, type PolicyOutcome } from './enums.js';

/*
 * Confidence x impact policy (decisions.md #4). Locked.
 * Lane I implements `decide()` over this grid; nothing else re-implements it.
 */

export const Thresholds = z.object({
  /** p >= auto: confident. */
  auto: z.number().min(0).max(1),
  /** second_opinion <= p < auto: middle band. */
  second_opinion: z.number().min(0).max(1),
  undo_hours: z.number().positive(),
});
export type Thresholds = z.infer<typeof Thresholds>;

export const CONFIDENCE_BANDS = ['confident', 'middle', 'low'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/**
 * The locked grid. `auto_second` = auto only if a second backend agrees
 * (same option, its p >= second_opinion); otherwise `human`.
 */
export const POLICY_GRID: Record<Impact, Record<ConfidenceBand, PolicyOutcome>> = {
  low: { confident: 'auto', middle: 'auto_second', low: 'human' },
  medium: { confident: 'auto_undo', middle: 'human', low: 'human' },
  high: { confident: 'human', middle: 'human', low: 'human' },
};

/** Second-opinion agreement bar (decisions.md: "its p >= 0.70"). */
export const SECOND_OPINION_MIN_P = 0.7;

export const BackendsConfig = z.object({
  default: z.enum(['jev', 'kev', 'llm']),
  fallback: z.enum(['jev', 'kev', 'llm']),
  jev: z.object({ baseUrl: z.string(), keyEnv: z.string() }),
  kev: z.object({ baseUrl: z.string() }),
  llm: z.object({ provider: z.literal('anthropic'), model: z.string().optional() }),
});

export const PolicyConfig = z.object({
  policy: Thresholds,
  /** Per decision-kind threshold overrides. */
  overrides: z.partialRecord(DecisionKind, Thresholds.partial()),
  backends: BackendsConfig,
  scoring: z.object({
    affinity_cap: z.number().int().min(0),
    company_active_cap: z.number().int().min(1),
    green_min: z.number(),
    yellow_min: z.number(),
  }),
  scout: z.object({ watchlist_share_max: z.number().min(0).max(1) }),
  linkedin: z.object({ max_profiles_per_day: z.number().int().min(0), min_delay_s: z.number().min(0) }),
  freshness: z.object({ stale_after_days: z.number().int().positive() }),
  schedules: z.object({
    inbox: z.string(),
    freshness: z.string(),
    scout_score: z.string(),
  }),
});
/** Shape of `$PP_HOME/config.json`. */
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export const DEFAULT_CONFIG: PolicyConfig = {
  policy: { auto: 0.9, second_opinion: 0.7, undo_hours: 24 },
  overrides: { 'freshness.closed': { auto: 0.92 } },
  backends: {
    default: 'jev',
    fallback: 'kev',
    jev: { baseUrl: '', keyEnv: 'JEV_API_KEY' },
    kev: { baseUrl: 'http://127.0.0.1:8009' },
    llm: { provider: 'anthropic' },
  },
  scoring: { affinity_cap: 5, company_active_cap: 3, green_min: 75, yellow_min: 55 },
  scout: { watchlist_share_max: 0.34 },
  linkedin: { max_profiles_per_day: 40, min_delay_s: 20 },
  freshness: { stale_after_days: 45 },
  schedules: { inbox: 'daily 07:30', freshness: 'daily 06:30', scout_score: 'fri 05:30' },
};

/** Effective thresholds for a decision kind (base merged with override). Pure data merge, no policy logic. */
export function thresholdsFor(config: PolicyConfig, kind: DecisionKind): Thresholds {
  return { ...config.policy, ...(config.overrides[kind] ?? {}) };
}
