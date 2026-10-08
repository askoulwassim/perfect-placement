import { z } from 'zod';
import { DecisionKind, type Impact, type PolicyOutcome, type ProfileComponentKey } from './enums.js';

/*
 * Confidence x impact policy (decisions.md #4, replaced by wave1-decisions #24).
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
 * The grid (wave1-decisions #24: the Claude Design prototype's cells). Columns:
 * confident = p >= auto, middle = second_opinion <= p < auto, low = p < second_opinion.
 * `auto_second` = auto only if a second opinion agrees (same option, its p >= SECOND_OPINION_MIN_P);
 * with Kev as the only System One backend the second opinion is the calling agent session or a
 * second Kev question, otherwise `human`.
 * HARD_HUMAN exclusions override every cell (see `isHardHuman`).
 */
export const POLICY_GRID: Record<Impact, Record<ConfidenceBand, PolicyOutcome>> = {
  low: { confident: 'auto', middle: 'auto', low: 'auto_undo' },
  medium: { confident: 'auto', middle: 'auto_second', low: 'human' },
  high: { confident: 'auto_undo', middle: 'human', low: 'human' },
};

/**
 * Hard exclusions (wave1-decisions #24): always `human`, whatever the grid or thresholds say.
 * Not tunable from Settings. Submit an application, send an email, delete anything,
 * change a dealbreaker, change the comp floor.
 */
export const HARD_HUMAN = {
  /** Decision kinds that are always human. */
  kinds: ['apply.submit'] as const satisfies readonly DecisionKind[],
  /** Ops that are always human. */
  ops: ['outreach.send'] as const,
  /** Any op whose name ends in one of these verbs deletes something. */
  deleteVerbs: ['delete', 'remove', 'purge'] as const,
  /** `profile.apply_diff` on these components is always human. */
  components: ['dealbreakers'] as const satisfies readonly ProfileComponentKey[],
  /** `profile.apply_diff` on `terms` is human when any of these keys change. */
  termsKeys: ['comp_floor', 'comp_floor_hard'] as const,
} as const;

export interface HardHumanSubject {
  kind?: DecisionKind;
  op?: string;
  /** For `profile.apply_diff`: the component the diff touches. */
  component?: ProfileComponentKey;
  /** For `profile.apply_diff`: keys whose value changes. */
  changedKeys?: readonly string[];
}

/** True when the decision or op must always go to the human (not tunable). */
export function isHardHuman({ kind, op, component, changedKeys }: HardHumanSubject): boolean {
  if (kind && (HARD_HUMAN.kinds as readonly string[]).includes(kind)) return true;
  if (op && (HARD_HUMAN.ops as readonly string[]).includes(op)) return true;
  if (op && HARD_HUMAN.deleteVerbs.some((v) => op === v || op.endsWith(`.${v}`) || op.endsWith(`_${v}`))) return true;
  // Component rules apply to profile diffs (`profile.apply_diff`, or a bare component check).
  if (component) {
    if ((HARD_HUMAN.components as readonly string[]).includes(component)) return true;
    if (component === 'terms' && (changedKeys ?? []).some((k) => (HARD_HUMAN.termsKeys as readonly string[]).includes(k))) return true;
  }
  return false;
}

/** Second-opinion agreement bar (decisions.md: "its p >= 0.70"). */
export const SECOND_OPINION_MIN_P = 0.7;

/** Backends the resolver may route to after `rule` (wave1-decisions #7, #9). */
export const ROUTABLE_BACKENDS = ['kev', 'agent', 'jev', 'llm'] as const;

export const BackendsConfig = z.object({
  default: z.enum(ROUTABLE_BACKENDS),
  fallback: z.enum(ROUTABLE_BACKENDS),
  kev: z.object({ baseUrl: z.string() }),
  /** Optional hosted System One adapter; off by default (Kev only). */
  jev: z.object({ baseUrl: z.string(), keyEnv: z.string(), enabled: z.boolean().default(false) }),
  /** The calling agent session (Claude Code, Codex, Cursor) over MCP. No settings yet. */
  agent: z.object({}).default({}),
  /** Optional direct LLM API adapter; absent by default (all LLM work runs in the agent session). */
  llm: z.object({ provider: z.literal('anthropic'), model: z.string().optional(), enabled: z.boolean().default(false) }).optional(),
});

/** Headless agent runner that `runs.start` launches (wave1-decisions #9). */
export const RUNNER_COMMANDS = ['claude', 'codex', 'cursor-agent'] as const;
export const RunnerConfig = z.object({ command: z.enum(RUNNER_COMMANDS), args: z.array(z.string()).optional() });
export type RunnerConfig = z.infer<typeof RunnerConfig>;

/** A schedule spec (e.g. `daily 07:30`) or `'off'`. */
export const ScheduleSpec = z.union([z.literal('off'), z.string().min(1)]);

export const LINKEDIN_MODES = ['off', 'dry-run', 'live'] as const;
export const LINKEDIN_DRIVERS = ['claude-in-chrome', 'playwright'] as const;

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
  runner: RunnerConfig,
  /** Read-only, capped, slow; never messages or connects. Tests use `dry-run`. */
  linkedin: z.object({
    mode: z.enum(LINKEDIN_MODES),
    driver: z.enum(LINKEDIN_DRIVERS),
    max_profiles_per_day: z.number().int().min(0),
    max_pages_per_run: z.number().int().min(0),
    max_mutual_expansions: z.number().int().min(0),
    min_delay_s: z.number().min(0),
  }),
  freshness: z.object({ stale_after_days: z.number().int().positive() }),
  schedules: z.object({
    inbox: ScheduleSpec,
    freshness: ScheduleSpec,
    scout_score: ScheduleSpec,
  }),
});
/** Shape of `$PP_HOME/config.json`. */
export type PolicyConfig = z.infer<typeof PolicyConfig>;

export const DEFAULT_CONFIG: PolicyConfig = {
  policy: { auto: 0.9, second_opinion: 0.7, undo_hours: 24 },
  overrides: { 'freshness.closed': { auto: 0.92 } },
  backends: {
    default: 'kev',
    fallback: 'agent',
    kev: { baseUrl: 'http://127.0.0.1:8009' },
    jev: { baseUrl: '', keyEnv: 'JEV_API_KEY', enabled: false },
    agent: {},
  },
  scoring: { affinity_cap: 5, company_active_cap: 3, green_min: 75, yellow_min: 55 },
  scout: { watchlist_share_max: 0.34 },
  runner: { command: 'claude' },
  linkedin: {
    mode: 'live',
    driver: 'claude-in-chrome',
    max_profiles_per_day: 40,
    max_pages_per_run: 6,
    max_mutual_expansions: 3,
    min_delay_s: 20,
  },
  freshness: { stale_after_days: 45 },
  schedules: { inbox: 'daily 07:30', freshness: 'daily 06:30', scout_score: 'fri 05:30' },
};

/** Effective thresholds for a decision kind (base merged with override). Pure data merge, no policy logic. */
export function thresholdsFor(config: PolicyConfig, kind: DecisionKind): Thresholds {
  return { ...config.policy, ...(config.overrides[kind] ?? {}) };
}
