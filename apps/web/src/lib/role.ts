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
