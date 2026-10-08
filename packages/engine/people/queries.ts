import type { Actor, Contact, ContactLink, EventType, Outreach, SubjectType } from '@perfect-placement/contracts';
import { ulid } from '../db/ids.js';
import type { Repos } from '../db/repo.js';
import type { PeopleDeps } from './types.js';

/*
 * Lane H row access over lane A's repositories (the only db access), plus the event writer and
 * staged vault the op context provides. Runs inside `runOp`'s transaction.
 */

export interface RoleRow {
  id: string;
  company_id: string;
  title: string;
  status: string;
  md_path: string | null;
}

export interface CompanyRow {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
}

export const newId = (deps: PeopleDeps, prefix: string): string => (deps.newId ?? ((p: string) => `${p}_${ulid()}`))(prefix);

export const getRole = (R: Repos, id: string): RoleRow | undefined => R.role.get(id);

export const getCompany = (R: Repos, id: string): CompanyRow | undefined => R.company.get(id);

/** Statuses at or past the user's pick (on-deck and later, not archived). */
export const PICKED_STATUSES = ['on-deck', 'draft-ready', 'applied', 'interviews', 'offers'] as const;

/** A role is picked when it reached on-deck or later, or a `role_picked` event exists for it. */
export function isPicked(R: Repos, role: RoleRow): boolean {
  if ((PICKED_STATUSES as readonly string[]).includes(role.status)) return true;
  if (role.status === 'archived') return false;
  return R.event.select(`type = 'role_picked' AND subject_type = 'role' AND subject_id = ? LIMIT 1`, [role.id]).length > 0;
}

// ------------------------------------------------------------------- contacts

export const getContact = (R: Repos, id: string): Contact | undefined => R.contact.get(id);

export function findContact(R: Repos, by: { linkedin_url?: string | null; email?: string | null }): Contact | undefined {
  if (by.linkedin_url) {
    const c = R.contact.list({ linkedin_url: by.linkedin_url })[0];
    if (c) return c;
  }
  if (by.email) return R.contact.select('lower(email) = lower(?) LIMIT 1', [by.email])[0];
  return undefined;
}

export function insertContact(R: Repos, c: Contact): void {
  R.contact.insert(c);
}

/** Fills only missing fields (headline, url, email). Never overwrites what is there. */
export function fillContact(R: Repos, existing: Contact, incoming: Pick<Contact, 'headline' | 'linkedin_url' | 'email'>): Contact {
  const next: Contact = {
    ...existing,
    headline: existing.headline ?? incoming.headline,
    linkedin_url: existing.linkedin_url ?? incoming.linkedin_url,
    email: existing.email ?? incoming.email,
  };
  if (next.headline !== existing.headline || next.linkedin_url !== existing.linkedin_url || next.email !== existing.email)
    R.contact.update(existing.id, { headline: next.headline, linkedin_url: next.linkedin_url, email: next.email });
  return next;
}

// ---------------------------------------------------------------- contact_link

export const getLinkForRole = (R: Repos, contactId: string, roleId: string): ContactLink | undefined =>
  R.contact_link.select('contact_id = ? AND role_id = ? ORDER BY id LIMIT 1', [contactId, roleId])[0];

export const getLinkForCompany = (R: Repos, contactId: string, companyId: string): ContactLink | undefined =>
  R.contact_link.select('contact_id = ? AND company_id = ? AND role_id IS NULL ORDER BY id LIMIT 1', [contactId, companyId])[0];

export function insertLink(R: Repos, l: ContactLink): void {
  R.contact_link.insert(l);
}

export function updateLink(R: Repos, l: ContactLink): void {
  R.contact_link.update(l.id, { degree: l.degree, tier: l.tier, via_contact_id: l.via_contact_id, is_hiring_team: l.is_hiring_team });
}

// -------------------------------------------------------------------- outreach

export const getOutreach = (R: Repos, id: string): Outreach | undefined => R.outreach.get(id);

export const getOutreachFor = (R: Repos, contactId: string, roleId: string): Outreach | undefined =>
  R.outreach.select('contact_id = ? AND role_id = ? ORDER BY id LIMIT 1', [contactId, roleId])[0];

export function upsertOutreach(R: Repos, o: Outreach, exists: boolean): void {
  if (exists) R.outreach.update(o.id, { tier: o.tier, gmail_draft_id: o.gmail_draft_id, status: o.status, md_path: o.md_path });
  else R.outreach.insert(o);
}

/** Connect is done once a draft for the role is in Gmail: move its application from `connect` to `fill`. */
export function advanceConnectToFill(R: Repos, roleId: string): void {
  const app = R.application.list({ role_id: roleId })[0];
  if (app?.stage === 'connect') R.application.update(app.id, { stage: 'fill' });
}

// --------------------------------------------------------------------- profile

/** Latest-version profile component (Story, Voice) with its markdown body. */
export function getComponent(deps: PeopleDeps, key: 'story' | 'voice'): { data: Record<string, unknown>; text: string } | null {
  const v = deps.repos.profile_version.select('1 ORDER BY created_at DESC, id DESC LIMIT 1')[0];
  if (!v) return null;
  const c = deps.repos.profile_component.list({ version_id: v.id, key })[0];
  if (!c) return null;
  const md = c.md_path ? readVault(deps, c.md_path) : null;
  return { data: c.data_json, text: md ? stripFrontmatter(md) : '' };
}

// ----------------------------------------------------------------- events, runs

/** Writes one event row through the op's emitter. */
export function emitEvent(
  deps: PeopleDeps,
  e: {
    type: EventType;
    subject_type: SubjectType;
    subject_id: string;
    payload: Record<string, unknown>;
    actor: Actor;
    ts: string;
    decision_id?: string;
  },
): string {
  return deps.emit(e.type, e.subject_type, e.subject_id, e.payload);
}

/** Records a finished people.find run (carries the LinkedIn budget). */
export function insertRun(
  deps: PeopleDeps,
  r: { op: string; started_at: string; finished_at: string; status: 'ok' | 'partial' | 'error'; summary: Record<string, unknown> },
): string {
  const id = newId(deps, 'rn');
  deps.repos.run.insert({
    id,
    op: r.op,
    started_at: r.started_at,
    finished_at: r.finished_at,
    status: r.status,
    summary_json: r.summary,
    log_path: null,
  });
  return id;
}

/** LinkedIn profiles read today (UTC day of `now`), summed over people.find runs. */
export function linkedinReadsOn(R: Repos, now: Date): number {
  const day = now.toISOString().slice(0, 10);
  return R.run
    .select(`op = 'people.find' AND substr(started_at, 1, 10) = ?`, [day])
    .reduce((n, r) => n + (Number(r.summary_json.linkedin_profiles_read) || 0), 0);
}

// ----------------------------------------------------------------------- vault

export const readVault = (deps: PeopleDeps, rel: string): string | null => deps.vault.read(rel);

export const writeVault = (deps: PeopleDeps, rel: string, content: string): void => deps.vault.write(rel, content);

export const stripFrontmatter = (md: string): string => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
