import type { Contact, ContactLink, ContactTier, EmailSource } from '@perfect-placement/contracts';

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

/** Email source in one word (#37). */
export const EMAIL_SOURCE_LABEL: Record<EmailSource, string> = {
  gmail: 'Gmail',
  linkedin: 'LinkedIn',
  public: 'Public',
  pattern: 'Guess',
  provider: 'Finder',
  manual: 'Manual',
};

/** "Guess 45%" / "Gmail" for a contact's email (#37); null when there is none. */
export function emailTag(
  c: Pick<Contact, 'email' | 'email_source' | 'email_confidence'>,
): { address: string; tag: string; sure: boolean } | null {
  if (!c.email) return null;
  const p = c.email_confidence;
  const sure = c.email_source === null || c.email_source === 'manual' || (p ?? 1) >= 0.9;
  const label = c.email_source ? EMAIL_SOURCE_LABEL[c.email_source] : 'Known';
  return { address: c.email, tag: p !== null && p < 1 ? `${label} ${Math.round(p * 100)}%` : label, sure };
}
