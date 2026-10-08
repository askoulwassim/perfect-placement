import type { ContactDegree, ContactRole, ContactTier } from '@perfect-placement/contracts';

/** Resolver answers that put a contact on the hiring team. */
export const HIRING_TEAM_ROLES: readonly ContactRole[] = ['hiring_manager', 'hiring_team', 'recruiter'];

export const isHiringTeam = (role: ContactRole): boolean => HIRING_TEAM_ROLES.includes(role);

/**
 * Tier = degree x hiring team (blueprint.md "Connect").
 *   1st:  warm_hiring | warm_other
 *   2nd:  bridge (same draft either way: a note to the mutual)
 *   cold: cold_hiring | cold_other
 */
export function tierFor(degree: ContactDegree, hiringTeam: boolean): ContactTier {
  if (degree === '1') return hiringTeam ? 'warm_hiring' : 'warm_other';
  if (degree === '2') return 'bridge';
  return hiringTeam ? 'cold_hiring' : 'cold_other';
}

/** Order the Connect screen uses for the best path: warm hiring first, cold other last. */
export const TIER_PRIORITY: Record<ContactTier, number> = { warm_hiring: 0, warm_other: 1, bridge: 2, cold_hiring: 3, cold_other: 4 };
