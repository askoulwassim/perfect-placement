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

/** Outcomes a per-kind override may give a confident decision (Wave 2 Phase 2). */
export const CONFIDENT_OUTCOMES = ['auto', 'auto_undo'] as const;

/**
 * Per decision-kind override (`config.overrides[kind]`): any threshold, plus `confident_outcome`,
 * which replaces the grid's plain `auto` for a confident decision with `auto_undo` (applied now,
 * one-tap undo for `undo_hours`). Hard exclusions still win.
 */
export const ThresholdOverride = Thresholds.partial().extend({ confident_outcome: z.enum(CONFIDENT_OUTCOMES).optional() });
export type ThresholdOverride = z.infer<typeof ThresholdOverride>;
/** Thresholds for one kind after the override merge. */
export type KindThresholds = Thresholds & { confident_outcome?: (typeof CONFIDENT_OUTCOMES)[number] };

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
export const ROUTABLE_BACKENDS = ['kev', 'agent', 'llm'] as const;

export const BackendsConfig = z.object({
  default: z.enum(ROUTABLE_BACKENDS),
  fallback: z.enum(ROUTABLE_BACKENDS),
  /** `model`: the Kev checkpoint `pp kev start` serves (`KEV_MODELS` in the cli); absent = kev-4b. */
  kev: z.object({ baseUrl: z.string(), model: z.string().optional() }),
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

/** Getting started path flags (#24): the steps not read from the pipeline itself. */
export const GuideState = z.object({
  policy: z.boolean().default(false),
  review: z.boolean().default(false),
  done: z.boolean().default(false),
});
export type GuideState = z.infer<typeof GuideState>;
export const DEFAULT_GUIDE: GuideState = { policy: false, review: false, done: false };

export const PolicyConfig = z.object({
  policy: Thresholds,
  /** Per decision-kind threshold overrides. */
  overrides: z.partialRecord(DecisionKind, ThresholdOverride),
  backends: BackendsConfig,
  scoring: z.object({
    affinity_cap: z.number().int().min(0),
    company_active_cap: z.number().int().min(1),
    green_min: z.number(),
    yellow_min: z.number(),
  }),
  /**
   * Scout (#28). `watchlist_share_max`: watchlist web-search queries as a share of a run's queries (ATS board
   * scans are not queries). `target_new_roles`: a run keeps building query variations until this many roles
   * were added or `max_queries` web searches ran. Defaults keep older config.json files valid.
   * #67: the share also caps a run's watchlist **adds** at `ceil(watchlist_share_max * target_new_roles)`.
   * `max_per_company`: most roles one company adds per run from its board (`scout.watchlist_scan`,
   * `roles.add` source `watchlist`); unset = `scoring.company_active_cap + 2` (`scoutMaxPerCompany`).
   */
  scout: z.object({
    watchlist_share_max: z.number().min(0).max(1),
    target_new_roles: z.number().int().min(1).default(25),
    max_queries: z.number().int().min(1).default(30),
    max_per_company: z.number().int().min(1).optional(),
  }),
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
  /** Run queue (#30): how many queued skill runs run at once (each is an agent session). */
  runs: z.object({ max_concurrent: z.number().int().min(1) }),
  /**
   * Automatic pipeline (#30), on by default. `score_after_scout`: a scout run that ends `ok` queues one
   * score run for the inbox. `research_after_score`: a score run that ends `ok` or `partial` queues one
   * research run per company of a role it kept (not archived) that has no dossier yet.
   */
  pipeline: z.object({ score_after_scout: z.boolean(), research_after_score: z.boolean() }),
  schedules: z.object({
    inbox: ScheduleSpec,
    freshness: ScheduleSpec,
    scout_score: ScheduleSpec,
  }),
  /**
   * UI state kept in the vault (wave1-decisions #27, superseded 2026-10-09: #24/#43). `guide`: the
   * Getting started path on Now. `policy`: Settings opened; `review`: River or Needs you opened with
   * scored roles; `done`: every step finished, the card never shows again. No user setting reads or
   * resets it; a dev reset is `pp op config.update` with `{ ui: { guide: { done: false, ... } } }`.
   * Optional: older config.json files (including ones with the retired `cues_seen`) parse unchanged.
   */
  ui: z.object({ guide: GuideState.default(DEFAULT_GUIDE) }).optional(),
});
/** Shape of `$PP_HOME/config.json`. */
export type PolicyConfig = z.infer<typeof PolicyConfig>;

/** Most roles one watchlist company adds per scout run (#67): `scout.max_per_company`, else the active cap + 2. */
export function scoutMaxPerCompany(config: Pick<PolicyConfig, 'scout' | 'scoring'>): number {
  return config.scout.max_per_company ?? config.scoring.company_active_cap + 2;
}

/** Most watchlist roles one scout run adds (#67): `ceil(watchlist_share_max * target_new_roles)`. */
export function scoutWatchlistMaxAdds(config: Pick<PolicyConfig, 'scout'>): number {
  return Math.ceil(config.scout.watchlist_share_max * config.scout.target_new_roles - 1e-9);
}

export const DEFAULT_CONFIG: PolicyConfig = {
  policy: { auto: 0.9, second_opinion: 0.7, undo_hours: 24 },
  overrides: {
    'freshness.closed': { auto: 0.92 },
    // wave1-decisions #14: confident profile diffs (asset components included) apply with a 24h undo.
    'profile.apply_diff': { confident_outcome: 'auto_undo' },
    // wave1-decisions #16: a confident confirmation (including one that revives an archived role) applies with a 24h undo.
    'inbox.classify': { confident_outcome: 'auto_undo' },
  },
  backends: {
    default: 'kev',
    fallback: 'agent',
    kev: { baseUrl: 'http://127.0.0.1:8009' },
    agent: {},
  },
  scoring: { affinity_cap: 5, company_active_cap: 3, green_min: 75, yellow_min: 55 },
  scout: { watchlist_share_max: 0.34, target_new_roles: 25, max_queries: 30 },
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
  runs: { max_concurrent: 2 },
  pipeline: { score_after_scout: true, research_after_score: true },
  schedules: { inbox: 'daily 07:30', freshness: 'daily 06:30', scout_score: 'fri 05:30' },
  ui: { guide: { ...DEFAULT_GUIDE } },
};

/** Effective thresholds for a decision kind (base merged with override). Pure data merge, no policy logic. */
export function thresholdsFor(config: PolicyConfig, kind: DecisionKind): KindThresholds {
  return { ...config.policy, ...(config.overrides[kind] ?? {}) };
}
