import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Actor, Contact, ContactLink, EventType, Outreach, SubjectType } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { defaultNewId } from './ids.js';
import type { PeopleDeps } from './types.js';

/*
 * Row access for lane H tables (contact, contact_link, outreach) plus the few reads it needs from
 * role, company, profile and run.
 * WAVE2-SHIM: lane A owns repositories and lane B's runOp writes events and runs. These helpers keep
 * lane H self-contained until then; Wave 2 swaps them for the shared repository layer.
 */

type Db = Database.Database;

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

export const newId = (deps: PeopleDeps, prefix: string): string => (deps.newId ?? defaultNewId)(prefix);

export const getRole = (db: Db, id: string): RoleRow | undefined =>
  db.prepare('SELECT id, company_id, title, status, md_path FROM role WHERE id = ?').get(id) as RoleRow | undefined;

export const getCompany = (db: Db, id: string): CompanyRow | undefined =>
  db.prepare('SELECT id, slug, name, domain FROM company WHERE id = ?').get(id) as CompanyRow | undefined;

/** Statuses at or past the user's pick (on-deck and later, not archived). */
export const PICKED_STATUSES = ['on-deck', 'draft-ready', 'applied', 'interviews', 'offers'] as const;

/** A role is picked when it reached on-deck or later, or a `role_picked` event exists for it. */
export function isPicked(db: Db, role: RoleRow): boolean {
  if ((PICKED_STATUSES as readonly string[]).includes(role.status)) return true;
  if (role.status === 'archived') return false;
  const ev = db.prepare("SELECT 1 FROM event WHERE type = 'role_picked' AND subject_type = 'role' AND subject_id = ? LIMIT 1").get(role.id);
  return ev !== undefined;
}

// ------------------------------------------------------------------- contacts

export const getContact = (db: Db, id: string): Contact | undefined =>
  db.prepare('SELECT * FROM contact WHERE id = ?').get(id) as Contact | undefined;

export function findContact(db: Db, by: { linkedin_url?: string | null; email?: string | null }): Contact | undefined {
  if (by.linkedin_url) {
    const c = db.prepare('SELECT * FROM contact WHERE linkedin_url = ?').get(by.linkedin_url) as Contact | undefined;
    if (c) return c;
  }
  if (by.email) return db.prepare('SELECT * FROM contact WHERE lower(email) = lower(?)').get(by.email) as Contact | undefined;
  return undefined;
}

export function insertContact(db: Db, c: Contact): void {
  db.prepare(
    'INSERT INTO contact (id, name, headline, linkedin_url, email, source, notes) VALUES (@id, @name, @headline, @linkedin_url, @email, @source, @notes)',
  ).run(c);
}

/** Fills only missing fields (headline, url, email). Never overwrites what is there. */
export function fillContact(db: Db, existing: Contact, incoming: Pick<Contact, 'headline' | 'linkedin_url' | 'email'>): Contact {
  const next: Contact = {
    ...existing,
    headline: existing.headline ?? incoming.headline,
    linkedin_url: existing.linkedin_url ?? incoming.linkedin_url,
    email: existing.email ?? incoming.email,
  };
  if (next.headline !== existing.headline || next.linkedin_url !== existing.linkedin_url || next.email !== existing.email) {
    db.prepare('UPDATE contact SET headline = @headline, linkedin_url = @linkedin_url, email = @email WHERE id = @id').run(next);
  }
  return next;
}

// ---------------------------------------------------------------- contact_link

interface LinkDbRow extends Omit<ContactLink, 'is_hiring_team'> {
  is_hiring_team: number;
}
const toLink = (r: LinkDbRow): ContactLink => ({ ...r, is_hiring_team: r.is_hiring_team === 1 });

export function getLinkForRole(db: Db, contactId: string, roleId: string): ContactLink | undefined {
  const r = db.prepare('SELECT * FROM contact_link WHERE contact_id = ? AND role_id = ? ORDER BY id LIMIT 1').get(contactId, roleId) as
    | LinkDbRow
    | undefined;
  return r ? toLink(r) : undefined;
}

export function getLinkForCompany(db: Db, contactId: string, companyId: string): ContactLink | undefined {
  const r = db
    .prepare('SELECT * FROM contact_link WHERE contact_id = ? AND company_id = ? AND role_id IS NULL ORDER BY id LIMIT 1')
    .get(contactId, companyId) as LinkDbRow | undefined;
  return r ? toLink(r) : undefined;
}

export function insertLink(db: Db, l: ContactLink): void {
  db.prepare(
    `INSERT INTO contact_link (id, contact_id, company_id, role_id, degree, tier, via_contact_id, is_hiring_team)
     VALUES (@id, @contact_id, @company_id, @role_id, @degree, @tier, @via_contact_id, @is_hiring_team)`,
  ).run({ ...l, is_hiring_team: l.is_hiring_team ? 1 : 0 });
}

export function updateLink(db: Db, l: ContactLink): void {
  db.prepare(
    'UPDATE contact_link SET degree = @degree, tier = @tier, via_contact_id = @via_contact_id, is_hiring_team = @is_hiring_team WHERE id = @id',
  ).run({ ...l, is_hiring_team: l.is_hiring_team ? 1 : 0 });
}

// -------------------------------------------------------------------- outreach

export const getOutreach = (db: Db, id: string): Outreach | undefined =>
  db.prepare('SELECT * FROM outreach WHERE id = ?').get(id) as Outreach | undefined;

export const getOutreachFor = (db: Db, contactId: string, roleId: string): Outreach | undefined =>
  db.prepare('SELECT * FROM outreach WHERE contact_id = ? AND role_id = ? ORDER BY id LIMIT 1').get(contactId, roleId) as
    | Outreach
    | undefined;

export function upsertOutreach(db: Db, o: Outreach, exists: boolean): void {
  if (exists) {
    db.prepare(
      'UPDATE outreach SET tier = @tier, gmail_draft_id = @gmail_draft_id, status = @status, md_path = @md_path WHERE id = @id',
    ).run(o);
  } else {
    db.prepare(
      'INSERT INTO outreach (id, contact_id, role_id, tier, gmail_draft_id, status, md_path) VALUES (@id, @contact_id, @role_id, @tier, @gmail_draft_id, @status, @md_path)',
    ).run(o);
  }
}

// --------------------------------------------------------------------- profile

/** Latest-version profile component (Story, Voice). WAVE2-SHIM: lane E's profile.get. */
export function getComponent(deps: PeopleDeps, key: 'story' | 'voice'): { data: Record<string, unknown>; text: string } | null {
  const row = deps.db
    .prepare(
      `SELECT pc.data_json, pc.md_path FROM profile_component pc JOIN profile_version pv ON pv.id = pc.version_id
       WHERE pc.key = ? ORDER BY pv.created_at DESC, pv.id DESC LIMIT 1`,
    )
    .get(key) as { data_json: string; md_path: string | null } | undefined;
  if (!row) return null;
  const md = row.md_path ? readVault(deps.vaultDir, row.md_path) : null;
  return { data: JSON.parse(row.data_json) as Record<string, unknown>, text: md ? stripFrontmatter(md) : '' };
}

// ----------------------------------------------------------------- events, runs

/** WAVE2-SHIM: runOp (lane B) writes event rows; handlers will return drafts instead. */
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
  const id = newId(deps, 'ev');
  deps.db
    .prepare('INSERT INTO event (id, ts, type, subject_type, subject_id, payload_json, actor, decision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, e.ts, e.type, e.subject_type, e.subject_id, JSON.stringify(e.payload), e.actor, e.decision_id ?? null);
  return id;
}

/** WAVE2-SHIM: lane B owns runs. Records a finished people.find run (carries the LinkedIn budget). */
export function insertRun(
  deps: PeopleDeps,
  r: { op: string; started_at: string; finished_at: string; status: string; summary: Record<string, unknown> },
): string {
  const id = newId(deps, 'rn');
  deps.db
    .prepare('INSERT INTO run (id, op, started_at, finished_at, status, summary_json, log_path) VALUES (?, ?, ?, ?, ?, ?, NULL)')
    .run(id, r.op, r.started_at, r.finished_at, r.status, JSON.stringify(r.summary));
  return id;
}

/** LinkedIn profiles read today (UTC day of `now`), summed over people.find runs. */
export function linkedinReadsOn(db: Db, now: Date): number {
  const day = now.toISOString().slice(0, 10);
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(json_extract(summary_json, '$.linkedin_profiles_read')), 0) AS n FROM run WHERE op = 'people.find' AND substr(started_at, 1, 10) = ?",
    )
    .get(day) as { n: number };
  return row.n;
}

// ----------------------------------------------------------------------- vault

export function readVault(vaultDir: string, rel: string): string | null {
  const p = join(vaultDir, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

export function writeVault(vaultDir: string, rel: string, content: string): void {
  const p = join(vaultDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

export const stripFrontmatter = (md: string): string => md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
