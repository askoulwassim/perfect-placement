import {
  type ArchiveReason,
  type Band,
  CRITERIA,
  type Criterion,
  isRemoteOnly,
  type ProfileComponent,
  type WorkMode,
} from '@perfect-placement/contracts';
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
  /** Where the role is based (#83). Default: the role row's location. */
  location?: string | null;
  comp_min?: number | null;
  comp_max?: number | null;
  /** Hard nos from the Dealbreakers component that the model judged the JD hits. */
  dealbreaker_hits?: string[];
  [k: string]: unknown;
}

export interface DealbreakerResult {
  hits: string[];
  /** Facts that need checking (unknown work mode or location, unknown comp). Never a hit on their own. */
  verify: string[];
}

/** What the role row knows when the facts leave it out (#83). */
export interface RoleBasics {
  location?: string | null;
  workplace?: string | null;
}

/** Hits the work-mode filter produces (#83). `roles.reevaluate_filters` re-checks archives made only of these. */
export const WORK_MODE_HITS = ['remote_required', 'work_mode_hard_no', 'work_mode_location'] as const;

function componentData(components: readonly ProfileComponent[], key: string): Record<string, unknown> {
  return (components.find((c) => c.key === key)?.data_json ?? {}) as Record<string, unknown>;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []);

/** A mode word: remote, hybrid or onsite (on-site, in office, office based). */
function modeOf(s: string): WorkMode | null {
  const t = s.toLowerCase();
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\b(on-?site|in[- ]office|office[- ]based|in[- ]person)\b/.test(t)) return 'onsite';
  if (/\bremote\b/.test(t)) return 'remote';
  return null;
}

/**
 * Dealbreakers hard nos that name only a mode ("onsite only", "no hybrid", "fully on-site roles").
 * Anything with a qualifier ("onsite outside NYC") is left to the skill's judgment.
 */
const MODE_HARD_NO =
  /^(no\s+)?(fully\s+|full[- ]time\s+|100%\s+|5[- ]day\s+)?(on-?site|in[- ]office|office[- ]based|in[- ]person|hybrid|remote)(\s+(only|roles?|jobs?|work))?$/i;

export function workModeHardNos(components: readonly ProfileComponent[]): Set<WorkMode> {
  const out = new Set<WorkMode>();
  for (const m of strList(componentData(components, 'work_mode').hard_nos)) {
    const mode = modeOf(m);
    if (mode) out.add(mode);
  }
  for (const t of strList(componentData(components, 'dealbreakers').hard_nos)) {
    if (!MODE_HARD_NO.test(t.trim())) continue;
    const mode = modeOf(t);
    if (mode) out.add(mode);
  }
  return out;
}

const PLACE_ALIASES: Array<[RegExp, string]> = [
  [/\bnew york city\b|\bnyc\b|\bmanhattan\b|\bbrooklyn\b/g, 'new york'],
  [/\bsan francisco bay area\b|\bbay area\b|\bsf\b/g, 'san francisco'],
  [/\bla\b/g, 'los angeles'],
  [/\bdc\b|\bwashington,? d\.?c\.?/g, 'washington'],
];
const COUNTRY_ONLY = /^(us|usa|u\.s\.a?\.?|united states|america|north america|anywhere|global|worldwide|uk|canada|europe|emea)$/;

function normPlace(s: string): string {
  let t = s.toLowerCase();
  for (const [re, to] of PLACE_ALIASES) t = t.replace(re, to);
  return t.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The city a profile place names ("New York, NY" -> "new york"); null for remote scopes and whole countries. */
function placeKey(s: string): string | null {
  const t = normPlace(s);
  if (/\bremote\b/.test(t)) return null;
  const city = (t.split(',')[0] ?? '').trim();
  if (!city || COUNTRY_ONLY.test(city)) return null;
  return city;
}

function placeMatches(profilePlace: string, roleLocation: string): boolean {
  const key = placeKey(profilePlace);
  if (!key) return false;
  const loc = normPlace(roleLocation);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}($|[^a-z])`).test(loc);
}

/**
 * Work-mode filter (#83). Honors the profile: accepted modes per place, hard nos, explicit remote only.
 * - remote, flexible or `remote_ok === true`: passes.
 * - hybrid or onsite: a mode hard no (Work mode `hard_nos`, or a Dealbreakers hard no naming only the mode,
 *   e.g. "onsite only") -> `work_mode_hard_no`; else explicit `remote_only` -> `remote_required`; else a
 *   `by_location` entry for the place decides (mode not listed -> `work_mode_location`); else a place in
 *   `locations` passes; elsewhere is a `location` verify flag (or `work_mode_location` when
 *   `outside_locations: 'fail'`); an unknown place is a `location` verify flag.
 * - unknown mode: a `work_mode` verify flag, never a hit (with `remote_only` and `remote_ok === false`: `remote_required`).
 * `modes` is a preference only: it never archives on its own.
 */
export function evaluateWorkMode(facts: ScoreFacts, components: readonly ProfileComponent[], role: RoleBasics = {}): DealbreakerResult {
  const hits: string[] = [];
  const verify: string[] = [];
  const wm = componentData(components, 'work_mode');
  const remoteOnly = isRemoteOnly(wm);
  const hardNos = workModeHardNos(components);
  const byLocation = Array.isArray(wm.by_location) ? (wm.by_location as Array<{ location?: unknown; modes?: unknown }>) : [];
  const locations = strList(wm.locations);
  const constrained = remoteOnly || hardNos.size > 0 || byLocation.length > 0 || locations.length > 0 || strList(wm.modes).length > 0;
  if (!constrained) return { hits, verify };

  const raw = facts.workplace ?? (typeof role.workplace === 'string' ? role.workplace : undefined);
  const wp = raw ? (modeOf(raw) ?? (raw.toLowerCase() === 'flexible' ? 'flexible' : null)) : null;
  if (facts.remote_ok === true || wp === 'remote' || wp === 'flexible') return { hits, verify };
  if (wp !== 'hybrid' && wp !== 'onsite') {
    if (remoteOnly && facts.remote_ok === false) hits.push('remote_required');
    else verify.push('work_mode');
    return { hits, verify };
  }
  if (hardNos.has(wp)) return { hits: ['work_mode_hard_no'], verify };
  if (remoteOnly) return { hits: ['remote_required'], verify };

  const loc = typeof facts.location === 'string' && facts.location.trim() ? facts.location : (role.location ?? null);
  if (!loc) return { hits, verify: ['location'] };
  const entry = byLocation.find((e) => typeof e.location === 'string' && placeMatches(e.location, loc));
  if (entry) {
    const ok = strList(entry.modes).some((m) => modeOf(m) === wp);
    return ok ? { hits, verify } : { hits: ['work_mode_location'], verify };
  }
  if (locations.some((p) => placeMatches(p, loc))) return { hits, verify };
  return wm.outside_locations === 'fail' ? { hits: ['work_mode_location'], verify } : { hits, verify: ['location'] };
}

/**
 * Filters gate. There is NO company exception of any kind (decisions.md #5): a dream company
 * that fails a filter is archived like any other.
 *
 * Rules (mechanical):
 * - work mode: `evaluateWorkMode` (#83).
 * - comp: only when Terms `comp_floor_hard === true` and comp_max < comp_floor (v1: comp is a C6 penalty, not a gate).
 * - judged: any `facts.dealbreaker_hits` (the model matched a hard no).
 */
export function evaluateDealbreakers(facts: ScoreFacts, components: readonly ProfileComponent[], role: RoleBasics = {}): DealbreakerResult {
  const { hits, verify } = evaluateWorkMode(facts, components, role);
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
  role: RoleBasics = {},
): ComputedScore {
  const base = baseTotal(criteria, rubric);
  const mod = affinityMod(affinity, rubric.affinity_cap);
  const total = clampTotal(base + mod);
  const band = bandFor(total, rubric);
  const dealbreakers = evaluateDealbreakers(facts, components, role);
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
