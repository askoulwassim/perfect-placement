import type { ConnectFallback, Contact, ContactLink, ContactTier, EmailSource, Run } from '@perfect-placement/contracts';

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

/** Why LinkedIn was not read for a role (#82), one to three words. */
export const LINKEDIN_REASON_LABEL: Record<string, string> = {
  no_browser: 'No browser',
  signed_out: 'Signed out',
  checkpoint: 'Checkpoint',
  capped: 'Daily cap',
  not_found: 'No page',
  error: 'Read failed',
  off: 'Off',
  dry_run: 'Dry run',
  invalid: 'Bad links',
  not_reported: 'Not read',
  not_run: 'Not run',
};

export type LinkedInState = { read: true; label: string; people: number } | { read: false; label: string; reason: string };

/**
 * LinkedIn for a role (#82), from its latest people.find run: "LinkedIn: N people" only when the agent
 * really read LinkedIn (`linkedin_mode: agent`); otherwise "LinkedIn not read" with the reason.
 */
export function linkedinState(runs: readonly Run[], roleId: string): LinkedInState {
  const last = runs
    .filter((r) => r.op === 'people.find' && (r.summary_json as { role_id?: string } | null)?.role_id === roleId)
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id))[0];
  const s = (last?.summary_json ?? {}) as { linkedin_mode?: string; linkedin_people?: number; linkedin_reason?: string | null };
  if (s.linkedin_mode === 'agent') {
    const n = s.linkedin_people ?? 0;
    return { read: true, label: `LinkedIn: ${n} ${n === 1 ? 'person' : 'people'}`, people: n };
  }
  const key = !last ? 'not_run' : (s.linkedin_reason ?? (s.linkedin_mode === 'off' ? 'off' : 'dry_run'));
  return { read: false, label: 'LinkedIn not read', reason: LINKEDIN_REASON_LABEL[key] ?? 'Not read' };
}

/** Which no-contact fallback Connect used for a role (#78), one or two words. */
export const FALLBACK_LABEL: Record<ConnectFallback, string> = {
  team_inbox: 'Hiring team',
  cold_leader: 'Cold leader',
  skipped: 'Skipped',
};
