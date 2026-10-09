import { titleTokens } from '../ops/dedupe.js';

/*
 * Cheap rule filter for whole-board listings (#28): title, seniority and work mode from the profile.
 * It only drops clear misses; the score skill judges fit. Pure.
 */

/** Words that set level or span, not the job family: never required to match a function phrase. */
const LEVEL_WORDS = new Set([
  'manager',
  'management',
  'manage',
  'lead',
  'leader',
  'leadership',
  'head',
  'director',
  'senior',
  'staff',
  'principal',
  'chief',
  'officer',
  'vice',
  'president',
  'group',
  'junior',
  'associate',
  'intern',
  'i',
  'ii',
  'iii',
  'iv',
]);

/**
 * Job-family words. A posting carrying one that no profile phrase (or `include` keyword) carries is a
 * different job ("Product Designer" for a PM profile).
 */
const FAMILY_WORDS = new Set([
  'engineer',
  'engineering',
  'developer',
  'designer',
  'design',
  'marketing',
  'marketer',
  'sales',
  'account',
  'accountant',
  'accounting',
  'recruiter',
  'recruiting',
  'talent',
  'counsel',
  'legal',
  'attorney',
  'paralegal',
  'analyst',
  'scientist',
  'researcher',
  'support',
  'specialist',
  'coordinator',
  'representative',
  'architect',
  'security',
  'finance',
  'fp',
  'communications',
  'partnerships',
  'success',
  'writer',
  'editor',
  'hrbp',
  'recruitment',
  'administrator',
  'assistant',
  'dentist',
  'nurse',
  'technician',
  'consultant',
]);

/** Ordered levels; a title's level is the highest word it carries. */
const LEVELS: Array<[number, string[]]> = [
  [0, ['intern', 'internship']],
  [1, ['junior', 'associate', 'entry', 'graduate', 'apprentice']],
  [3, ['senior']],
  [4, ['staff', 'lead']],
  [5, ['principal']],
  [6, ['director', 'head', 'group']],
  [7, ['vice']],
  [8, ['chief']],
];

export function levelOf(text: string): number | null {
  const t = titleTokens(text);
  let best: number | null = null;
  for (const [rank, words] of LEVELS) if (words.some((w) => t.has(w))) best = Math.max(best ?? rank, rank);
  return best;
}

/** Lowest level a profile level string names ("principal", "senior / staff"). */
function minLevelOf(text: string): number | null {
  const t = titleTokens(text);
  let low: number | null = null;
  for (const [rank, words] of LEVELS) if (words.some((w) => t.has(w))) low = Math.min(low ?? rank, rank);
  return low;
}

const US_MARKERS = /\b(us|usa|u\.s\.?|united states|north america|americas)\b/;
const NON_US_MARKERS =
  /\b(europe|emea|uk|united kingdom|england|london|berlin|germany|france|paris|ireland|dublin|amsterdam|netherlands|spain|madrid|portugal|lisbon|poland|warsaw|india|bangalore|bengaluru|hyderabad|singapore|apac|asia|japan|tokyo|australia|sydney|melbourne|canada|toronto|vancouver|brazil|latam|mexico|israel|tel aviv|korea|seoul)\b/;

export interface ScanRules {
  /** Each phrase's family tokens; a title must hold every token of at least one phrase. */
  phrases: string[][];
  /** Family words the profile allows. */
  families: Set<string>;
  exclude: Set<string>;
  /** Lowest acceptable posting level (profile level minus two); null = no seniority rule. */
  minLevel: number | null;
  /** Work mode is exactly remote (lane F dealbreaker). */
  remoteOnly: boolean;
  /** Profile locations are US-only: postings placed only outside the US are dropped. */
  usOnly: boolean;
}

export interface ProfileForScan {
  craft?: Record<string, unknown>;
  work_mode?: Record<string, unknown>;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? [v] : []);

/**
 * Rules from Craft (functions, target, adjacent, explore, level) and Work mode (modes, locations).
 * `include` replaces the Craft phrases; `exclude` adds words that drop a title.
 */
export function rulesFromProfile(p: ProfileForScan, overrides: { include?: string[]; exclude?: string[] } = {}): ScanRules {
  const craft = p.craft ?? {};
  const wm = p.work_mode ?? {};
  const source = overrides.include?.length
    ? overrides.include
    : [...strList(craft.functions), ...strList(craft.target), ...strList(craft.adjacent), ...strList(craft.explore)];
  const phrases: string[][] = [];
  const families = new Set<string>();
  for (const s of source) {
    const toks = [...titleTokens(s)];
    for (const t of toks) if (FAMILY_WORDS.has(t)) families.add(t);
    const core = toks.filter((t) => !LEVEL_WORDS.has(t));
    if (core.length) phrases.push(core);
  }
  const level = typeof craft.level === 'string' ? minLevelOf(craft.level) : null;
  const modes = strList(wm.modes).map((m) => m.toLowerCase());
  const locs = strList(wm.locations).map((l) => l.toLowerCase());
  return {
    phrases,
    families,
    exclude: new Set((overrides.exclude ?? []).flatMap((x) => [...titleTokens(x)])),
    minLevel: level === null ? null : Math.max(0, level - 2),
    remoteOnly: modes.length === 1 && modes[0] === 'remote',
    usOnly: locs.length > 0 && locs.every((l) => US_MARKERS.test(l)),
  };
}

export type ScreenReason = 'title' | 'seniority' | 'work_mode' | 'location';

export interface Screenable {
  title: string;
  location: string | null;
  workplace: string | null;
}

/** Keep, or the first rule the posting clearly misses. */
export function screen(p: Screenable, r: ScanRules): { keep: true } | { keep: false; reason: ScreenReason } {
  const t = titleTokens(p.title);
  if ([...t].some((w) => r.exclude.has(w))) return { keep: false, reason: 'title' };
  if (r.phrases.length) {
    if (!r.phrases.some((ph) => ph.every((w) => t.has(w)))) return { keep: false, reason: 'title' };
    if ([...t].some((w) => FAMILY_WORDS.has(w) && !r.families.has(w))) return { keep: false, reason: 'title' };
  }
  if (r.minLevel !== null) {
    const lvl = levelOf(p.title);
    if (lvl !== null && lvl < r.minLevel) return { keep: false, reason: 'seniority' };
  }
  const w = p.workplace?.toLowerCase() ?? null;
  if (r.remoteOnly && (w === 'onsite' || w === 'hybrid')) return { keep: false, reason: 'work_mode' };
  if (r.usOnly && p.location) {
    const l = p.location.toLowerCase();
    if (NON_US_MARKERS.test(l) && !US_MARKERS.test(l)) return { keep: false, reason: 'location' };
  }
  return { keep: true };
}
