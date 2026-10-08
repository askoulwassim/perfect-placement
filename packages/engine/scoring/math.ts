import { type ArchiveReason, type Band, CRITERIA, type Criterion, type ProfileComponent } from '@perfect-placement/contracts';
import type { Rubric } from './rubric.js';

export type Criteria = Record<Criterion, number>;

export function assertCriteria(c: Partial<Record<Criterion, unknown>>): asserts c is Criteria {
  for (const k of CRITERIA) {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 5) throw new Error(`${k} must be an integer 1..5, got ${String(v)}`);
  }
}

/** Weighted total before the affinity modifier. Integer, like v1. */
export function baseTotal(c: Criteria, r: Pick<Rubric, 'weights' | 'scale'>): number {
  assertCriteria(c);
  const raw =
    r.scale === 'v1'
      ? CRITERIA.reduce((s, k) => s + c[k] * r.weights[k], 0) / 5
      : CRITERIA.reduce((s, k) => s + (r.weights[k] * (c[k] - 1)) / 4, 0);
  return Math.round(raw);
}

/** Affinity nudge, capped at +/- affinity_cap (decisions.md #5). Never more, whatever the source says. */
export function affinityMod(affinity: number | null | undefined, cap: number): number {
  if (typeof affinity !== 'number' || !Number.isFinite(affinity)) return 0;
  const c = Math.max(0, cap);
  return Math.max(-c, Math.min(c, Math.round(affinity)));
}

export function clampTotal(t: number): number {
  return Math.max(0, Math.min(100, t));
}

export function bandFor(total: number, r: Pick<Rubric, 'green_min' | 'yellow_min'>): Band {
  return total >= r.green_min ? 'green' : total >= r.yellow_min ? 'yellow' : 'red';
}

// ------------------------------------------------------------- dealbreakers

/** Facts the score skill extracts (judgment). Stored in `score.facts_json`. */
export interface ScoreFacts {
  workplace?: 'remote' | 'hybrid' | 'onsite' | 'flexible' | 'unspecified';
  /** true = remote allowed, false = not, null/undefined = unknown. */
  remote_ok?: boolean | null;
  comp_min?: number | null;
  comp_max?: number | null;
  /** Hard nos from the Dealbreakers component that the model judged the JD hits. */
  dealbreaker_hits?: string[];
  [k: string]: unknown;
}

export interface DealbreakerResult {
  hits: string[];
  /** Facts that need checking (unknown remote, unknown comp). Never a hit on their own. */
  verify: string[];
}

function componentData(components: readonly ProfileComponent[], key: string): Record<string, unknown> {
  return (components.find((c) => c.key === key)?.data_json ?? {}) as Record<string, unknown>;
}

/**
 * Filters gate. There is NO company exception of any kind (decisions.md #5): a dream company
 * that fails a filter is archived like any other.
 *
 * Rules (mechanical):
 * - remote: Work mode `modes` is exactly ['remote'] -> onsite, or remote_ok === false, or hybrid without remote_ok === true, is a hit.
 * - comp: only when Terms `comp_floor_hard === true` and comp_max < comp_floor (v1: comp is a C6 penalty, not a gate).
 * - judged: any `facts.dealbreaker_hits` (the model matched a hard no).
 */
export function evaluateDealbreakers(facts: ScoreFacts, components: readonly ProfileComponent[]): DealbreakerResult {
  const hits: string[] = [];
  const verify: string[] = [];
  const workMode = componentData(components, 'work_mode');
  const modes = Array.isArray(workMode.modes) ? (workMode.modes as unknown[]).map(String) : [];
  const remoteRequired = modes.length > 0 && modes.every((m) => m === 'remote');
  if (remoteRequired) {
    const wp = facts.workplace;
    if (facts.remote_ok === false || wp === 'onsite' || (wp === 'hybrid' && facts.remote_ok !== true)) hits.push('remote_required');
    else if (facts.remote_ok !== true && wp !== 'remote' && wp !== 'flexible') verify.push('remote');
  }
  const terms = componentData(components, 'terms');
  const floor = typeof terms.comp_floor === 'number' ? terms.comp_floor : null;
  if (floor !== null) {
    const top = facts.comp_max ?? facts.comp_min ?? null;
    if (top === null) verify.push('comp');
    else if (top < floor && terms.comp_floor_hard === true) hits.push('comp_floor');
  }
  for (const h of facts.dealbreaker_hits ?? []) if (typeof h === 'string' && h.trim()) hits.push(`judged:${h.trim()}`);
  return { hits, verify };
}

// ------------------------------------------------------------------ result

export interface ComputedScore {
  base: number;
  affinity_mod: number;
  total: number;
  band: Band;
  dealbreakers: DealbreakerResult;
  /** Before the per-company cap: active or archived. The cap may turn active into held. */
  verdict: 'active' | 'archived';
  archive_reason: Extract<ArchiveReason, 'below_threshold' | 'dealbreaker'> | null;
}

export function computeScore(
  criteria: Criteria,
  facts: ScoreFacts,
  rubric: Rubric,
  components: readonly ProfileComponent[],
  affinity: number | null | undefined,
): ComputedScore {
  const base = baseTotal(criteria, rubric);
  const mod = affinityMod(affinity, rubric.affinity_cap);
  const total = clampTotal(base + mod);
  const band = bandFor(total, rubric);
  const dealbreakers = evaluateDealbreakers(facts, components);
  const archive_reason = dealbreakers.hits.length > 0 ? 'dealbreaker' : band !== 'green' ? 'below_threshold' : null;
  return { base, affinity_mod: mod, total, band, dealbreakers, verdict: archive_reason ? 'archived' : 'active', archive_reason };
}

/** Affinity for a company: the profile version's Company component wins (versioned), else the company row. */
export function affinityFor(companySlug: string, companyRowAffinity: number | null, components: readonly ProfileComponent[]): number {
  const map = componentData(components, 'company').affinity;
  if (map && typeof map === 'object') {
    const v = (map as Record<string, unknown>)[companySlug];
    if (typeof v === 'number') return v;
  }
  return companyRowAffinity ?? 0;
}
