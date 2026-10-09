import { titleSimilarity, titleTokens } from '../ops/dedupe.js';
import { levelOf, rulesFromProfile } from './filter.js';

/*
 * Board candidate ranking (#67). A big board (Stripe lists 700+ roles) must not flood a run: candidates
 * are ranked by title and profile fit, near-identical titles at one company are grouped, and at most
 * `max_per_company` per company are returned. Cheap and deterministic; scoring still judges fit. Pure.
 */

/** Same company, title similarity at or above: one candidate stands for the group (#67). */
export const GROUP_TITLE_MIN = 0.85;

export interface FitProfile {
  craft?: Record<string, unknown>;
  domain?: Record<string, unknown>;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? [v] : []);

/** Unlevelled titles ("Product Manager") read as mid level. */
const DEFAULT_TITLE_LEVEL = 2;

export type FitScorer = (title: string) => number;

/**
 * Fit of a title to the profile, higher is better:
 * - +3 when it holds a Craft `functions` / `target` / `titles` phrase, +1.5 for an `adjacent` / `explore` one;
 * - up to +2 for Domain words, weighted by the domain's rank;
 * - -0.5 per level step away from the Craft level.
 */
export function fitScorer(p: FitProfile): FitScorer {
  const craft = p.craft ?? {};
  const primary = rulesFromProfile({
    craft: { functions: [...strList(craft.functions), ...strList(craft.target), ...strList(craft.titles)] },
  }).phrases;
  const secondary = rulesFromProfile({ craft: { functions: [...strList(craft.adjacent), ...strList(craft.explore)] } }).phrases;
  const domains = strList(p.domain?.ranked).map((d) => [...titleTokens(d)]);
  const target = typeof craft.level === 'string' ? levelOf(craft.level) : null;
  return (title: string) => {
    const t = titleTokens(title);
    const holds = (phrases: string[][]) => phrases.some((ph) => ph.every((w) => t.has(w)));
    let s = holds(primary) ? 3 : holds(secondary) ? 1.5 : 0;
    let dom = 0;
    domains.forEach((toks, i) => {
      if (!toks.length) return;
      const share = toks.filter((w) => t.has(w)).length / toks.length;
      dom = Math.max(dom, share * (1 - i / domains.length));
    });
    s += 2 * dom;
    if (target !== null) s -= 0.5 * Math.abs((levelOf(title) ?? DEFAULT_TITLE_LEVEL) - target);
    return s;
  };
}

export interface Rankable {
  title: string;
  url: string;
  posted_at?: string;
}

export interface CompanyCut<T> {
  kept: T[];
  /** Near-identical titles folded into a kept one. */
  groups: Array<{ kept: T; similar: T[] }>;
  grouped: number;
  capped: number;
}

/** Best first: fit, then newest posting, then listing order. */
export function rankByFit<T extends Rankable>(items: readonly T[], fit: FitScorer): T[] {
  return items
    .map((c, i) => ({ c, i, f: fit(c.title) }))
    .sort((a, b) => b.f - a.f || (b.c.posted_at ?? '').localeCompare(a.c.posted_at ?? '') || a.i - b.i)
    .map((x) => x.c);
}

/** One company's candidates: ranked, near-identical titles grouped, at most `max` kept. */
export function cutCompany<T extends Rankable>(items: readonly T[], fit: FitScorer, max: number): CompanyCut<T> {
  const groups: Array<{ kept: T; similar: T[] }> = [];
  let grouped = 0;
  for (const c of rankByFit(items, fit)) {
    const g = groups.find((x) => titleSimilarity(x.kept.title, c.title) >= GROUP_TITLE_MIN);
    if (g) {
      g.similar.push(c);
      grouped++;
    } else groups.push({ kept: c, similar: [] });
  }
  const n = Math.max(1, Math.floor(max));
  return {
    kept: groups.slice(0, n).map((g) => g.kept),
    groups: groups.slice(0, n).filter((g) => g.similar.length),
    grouped,
    capped: Math.max(0, groups.length - n),
  };
}

/** Round-robin across companies (each list best first), so the first N candidates spread across companies. */
export function interleave<T>(lists: readonly T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i] as T);
  return out;
}
