import type { Company, Role, Score } from '@perfect-placement/contracts';
import type { Fresh } from '../components/glyphs';

export interface RoleView {
  role: Role;
  company: Company;
  latest_score: Score | null;
}

/** Full emerald only when open and checked in the last 24h. */
export function freshOf(role: Pick<Role, 'freshness' | 'last_checked_at'>, now: Date): Fresh {
  if (role.freshness === 'closed') return 'closed';
  if (role.freshness === 'unsure') return 'unsure';
  if (role.freshness === 'open' && role.last_checked_at && now.getTime() - Date.parse(role.last_checked_at) < 86_400_000) return 'ok';
  return 'none';
}

export const criteriaOf = (s: Score) => [s.c1, s.c2, s.c3, s.c4, s.c5, s.c6, s.c7, s.c8, s.c9];

/** Who judged a criterion, in one word (#40). */
export const SOURCE_LABEL: Record<string, string> = { kev: 'Kev', agent: 'Agent', human: 'You', rule: 'Rule', jev: 'Jev', llm: 'Model' };

export interface CriterionSourceView {
  /** 'C1'..'C9' */
  id: string;
  label: string;
  /** 0..100, null when unknown. */
  pct: number | null;
  /** Kev's value when it disagreed with the agent by more than a point. */
  kev: number | null;
}

/** Per-criterion source + confidence from `score.facts_json` (criteria_source, disagreements). Empty for older scores. */
export function sourcesOf(s: Score): CriterionSourceView[] {
  const facts = (s.facts_json ?? {}) as {
    criteria_source?: Record<string, { backend?: string; p?: number }>;
    disagreements?: Array<{ criterion?: string; kev?: number }>;
  };
  const src = facts.criteria_source;
  if (!src || typeof src !== 'object') return [];
  const split = new Map((facts.disagreements ?? []).map((d) => [d.criterion, d.kev]));
  return ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9'].map((c) => {
    const x = src[c];
    const kev = split.get(c);
    return {
      id: c.toUpperCase(),
      label: (x?.backend && SOURCE_LABEL[x.backend]) || '—',
      pct: typeof x?.p === 'number' ? Math.round(x.p * 100) : null,
      kev: typeof kev === 'number' ? kev : null,
    };
  });
}
