import type { Contact, ContactLink, ContactTier } from '@perfect-placement/contracts';

export interface Person {
  contact: Contact;
  link: ContactLink;
}

/** Warmest route first. A bridge (2nd degree) beats a warm non-hiring 1st degree for reaching the team. */
export const TIER_RANK: Record<ContactTier, number> = { warm_hiring: 0, bridge: 1, warm_other: 2, cold_hiring: 3, cold_other: 4 };

export const TIER_LABEL: Record<ContactTier, string> = {
  warm_hiring: 'Warm hiring',
  warm_other: 'Warm',
  bridge: 'Bridge',
  cold_hiring: 'Cold hiring',
  cold_other: 'Cold',
};

/** Tone variant per tier (Outreach draft). */
export const TONES: ReadonlyArray<{ tier: ContactTier; label: string }> = [
  { tier: 'warm_hiring', label: 'Ask to talk' },
  { tier: 'warm_other', label: 'Coffee or intro' },
  { tier: 'bridge', label: 'Forwardable blurb' },
  { tier: 'cold_hiring', label: 'Positioning note' },
];

export const initials = (name: string) =>
  name
    .replace(/\./g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

export const sortPeople = (people: readonly Person[]) => [...people].sort((a, b) => TIER_RANK[a.link.tier] - TIER_RANK[b.link.tier]);

/** The best path to the hiring team: target person plus the hop names from You. */
export function bestPath(people: readonly Person[]): { target: Person; path: string[] } | null {
  const target = sortPeople(people)[0];
  if (!target) return null;
  const via = target.link.via_contact_id ? people.find((p) => p.contact.id === target.link.via_contact_id) : undefined;
  return { target, path: ['You', ...(via ? [via.contact.name] : []), target.contact.name] };
}
