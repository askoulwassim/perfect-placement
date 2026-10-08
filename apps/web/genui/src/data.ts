/*
 * Data the generated cards hydrate from. The model emits ids only; cards look the
 * facts up here, so a reply can never show a score or title the system does not hold.
 * Spike: backed by @perfect-placement/fixtures. Wave 2: back it with the ops client
 * (roles.get, scores latest, people.list, profile diffs) from lane D / lane B.
 */
import type { Company, Contact, ContactTier, ProfileDiff, Role, Score } from '@perfect-placement/contracts';
import { companies, contactLinks, contacts, profileDiffs, roles, scores } from '@perfect-placement/fixtures';
import { createContext, useContext } from 'react';

export interface GenuiData {
  role(id: string): Role | undefined;
  company(id: string): Company | undefined;
  latestScore(roleId: string): Score | undefined;
  contact(id: string): Contact | undefined;
  /** Best tier this contact has for the role (or for any role when roleId is absent). */
  tier(contactId: string, roleId?: string): ContactTier | undefined;
  diff(id: string): ProfileDiff | undefined;
}

export function fixtureData(): GenuiData {
  const byId = <T extends { id: string }>(rows: readonly T[]) => new Map(rows.map((r) => [r.id, r]));
  const roleMap = byId(roles);
  const companyMap = byId(companies);
  const contactMap = byId(contacts);
  const diffMap = byId(profileDiffs);
  const latest = new Map<string, Score>();
  for (const s of scores) {
    const prev = latest.get(s.role_id);
    if (!prev || s.created_at >= prev.created_at) latest.set(s.role_id, s);
  }
  return {
    role: (id) => roleMap.get(id),
    company: (id) => companyMap.get(id),
    latestScore: (roleId) => latest.get(roleId),
    contact: (id) => contactMap.get(id),
    tier: (contactId, roleId) => contactLinks.find((l) => l.contact_id === contactId && (!roleId || l.role_id === roleId))?.tier,
    diff: (id) => diffMap.get(id),
  };
}

export const GenuiDataContext = createContext<GenuiData | null>(null);

export function useGenuiData(): GenuiData {
  const data = useContext(GenuiDataContext);
  if (!data) throw new Error('GenuiDataContext missing: wrap the Ask panel in <GenuiDataContext value={...}>');
  return data;
}
