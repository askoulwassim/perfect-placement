import { type Contact, type ContactLink, ContactSource, peopleFind } from '@perfect-placement/contracts';
import { z } from 'zod';
import type { CollectResult, Degree } from '../integrations/linkedin/index.js';
import { KNOWN_CONFIDENCE } from './email.js';
import {
  emitEvent,
  fillContact,
  findContact,
  getCompany,
  getContact,
  getLinkForRole,
  getRole,
  insertContact,
  insertLink,
  insertRun,
  isPicked,
  linkedinReadsOn,
  newId,
  updateLink,
} from './queries.js';
import { tierFor } from './tier.js';
import { err, type Handler, type PeopleDeps } from './types.js';

/** People named in the JD or on the company team page, supplied by the connect skill (judgment). */
export const PersonHint = z.object({
  name: z.string().min(1).max(120),
  headline: z.string().max(200).nullable().optional(),
  linkedin_url: z.string().url().nullable().optional(),
  email: z.string().email().nullable().optional(),
  source: ContactSource.exclude(['linkedin', 'gmail']).default('jd'),
});
export type PersonHint = z.infer<typeof PersonHint>;

export const PeopleFindInput = peopleFind.input.extend({
  hints: z.array(PersonHint).max(20).optional(),
  /** LinkedIn company vanity slug when it differs from the PP company slug. */
  linkedin_company_slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});
export type PeopleFindInput = z.infer<typeof PeopleFindInput>;

interface Candidate {
  name: string;
  headline: string | null;
  linkedin_url: string | null;
  email: string | null;
  source: Contact['source'];
  degree: Degree;
  via: { name: string; headline: string | null; url: string } | null;
}

/** Source + confidence of an address people.find saw (#37): Gmail, LinkedIn, the JD or a public page. */
export function knownEmail(email: string | null, source: Contact['source']): Pick<Contact, 'email_source' | 'email_confidence'> {
  if (!email) return { email_source: null, email_confidence: null };
  const s = source === 'jd' || source === 'company_site' ? 'public' : source;
  return { email_source: s, email_confidence: KNOWN_CONFIDENCE[s] };
}

const EMPTY_COLLECT = (mode: 'dry-run' | 'live', capped: boolean): CollectResult => ({
  people: [],
  profilesRead: 0,
  pagesOpened: 0,
  capped,
  mode,
});

/**
 * people.find: LinkedIn (read-only, capped), Gmail contacts at the company domain, and skill hints.
 * Upserts contacts (name, headline, URL, email only) and links them to the role with a provisional
 * tier (not hiring team) until people.classify runs. Picked roles only.
 */
export const findPeople: Handler<'people.find'> = async (raw, ctx, deps) => {
  const parsed = PeopleFindInput.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'people.find input', parsed.error.issues);
  const input = parsed.data;
  const dryRun = Boolean(input.dry_run || ctx.dryRun);
  const { repos: db } = deps;

  const role = getRole(db, input.role_id);
  if (!role) return err('not_found', `role ${input.role_id}`);
  const company = getCompany(db, role.company_id);
  if (!company) return err('not_found', `company ${role.company_id}`);
  if (!isPicked(db, role)) return err('conflict', `role ${role.id} is not picked; people.find runs on picked roles only`);

  const started = ctx.now().toISOString();
  const cap = deps.config.linkedin.max_profiles_per_day;
  const remaining = Math.max(0, cap - linkedinReadsOn(db, ctx.now()));

  let collected: CollectResult = EMPTY_COLLECT(deps.linkedin?.mode ?? 'dry-run', false);
  if (deps.linkedin) {
    collected =
      remaining > 0
        ? await deps.linkedin.collect({
            companyName: company.name,
            companyLinkedInSlug: input.linkedin_company_slug ?? company.slug,
            roleTitle: role.title,
            maxProfiles: remaining,
          })
        : EMPTY_COLLECT(deps.linkedin.mode, true);
  }

  const candidates: Candidate[] = collected.people.map((p) => ({
    name: p.name,
    headline: p.headline,
    linkedin_url: p.url,
    email: null,
    source: 'linkedin',
    degree: p.degree,
    via: p.via,
  }));
  if (deps.gmailContacts && company.domain) {
    for (const g of await deps.gmailContacts.searchByDomain(company.domain)) {
      candidates.push({ name: g.name, headline: null, linkedin_url: null, email: g.email, source: 'gmail', degree: '1', via: null });
    }
  }
  for (const h of input.hints ?? []) {
    candidates.push({
      name: h.name,
      headline: h.headline ?? null,
      linkedin_url: h.linkedin_url ?? null,
      email: h.email ?? null,
      source: h.source,
      degree: 'cold',
      via: null,
    });
  }

  const found: Array<{ contact: Contact; link: ContactLink }> = [];
  const eventIds: string[] = [];
  const seen = new Set<string>();

  /** Resolve or create a contact row. In dry run, nothing is written and ids are placeholders. */
  const resolveContact = (c: Omit<Candidate, 'degree' | 'via'>): { contact: Contact; created: boolean } => {
    const existing = findContact(db, { linkedin_url: c.linkedin_url, email: c.email });
    if (existing) {
      return { contact: dryRun ? existing : fillContact(db, existing, { ...c, ...knownEmail(c.email, c.source) }), created: false };
    }
    const contact: Contact = {
      id: newId(deps, 'ct'),
      name: c.name,
      headline: c.headline,
      linkedin_url: c.linkedin_url,
      email: c.email,
      source: c.source,
      notes: null,
      ...knownEmail(c.email, c.source),
    };
    if (!dryRun) insertContact(db, contact);
    return { contact, created: true };
  };

  const apply = () => {
    for (const cand of candidates) {
      const { contact, created } = resolveContact(cand);
      if (seen.has(contact.id)) continue;
      seen.add(contact.id);

      let viaId: string | null = null;
      if (cand.degree === '2' && cand.via) {
        viaId = resolveContact({
          name: cand.via.name,
          headline: cand.via.headline,
          linkedin_url: cand.via.url,
          email: null,
          source: 'linkedin',
        }).contact.id;
      }

      let link = getLinkForRole(db, contact.id, role.id);
      if (link) {
        // Closer relationship found: upgrade degree, keep the hiring-team call already made.
        const rank = { '1': 0, '2': 1, cold: 2 } as const;
        if (rank[cand.degree] < rank[link.degree]) {
          link = {
            ...link,
            degree: cand.degree,
            via_contact_id: viaId ?? link.via_contact_id,
            tier: tierFor(cand.degree, link.is_hiring_team),
          };
          if (!dryRun) updateLink(db, link);
        }
      } else {
        link = {
          id: newId(deps, 'cl'),
          contact_id: contact.id,
          company_id: company.id,
          role_id: role.id,
          degree: cand.degree,
          tier: tierFor(cand.degree, false),
          via_contact_id: viaId,
          is_hiring_team: false,
        };
        if (!dryRun) {
          insertLink(db, link);
          eventIds.push(
            emitEvent(deps, {
              type: 'contact_found',
              subject_type: 'contact',
              subject_id: contact.id,
              payload: { role_id: role.id, source: cand.source, degree: cand.degree, new_contact: created },
              actor: ctx.actor,
              ts: started,
            }),
          );
        }
      }
      found.push({ contact: dryRun ? contact : (getContact(db, contact.id) ?? contact), link });
    }
    if (!dryRun) {
      insertRun(deps, {
        op: 'people.find',
        started_at: started,
        finished_at: ctx.now().toISOString(),
        status: collected.capped ? 'partial' : 'ok',
        summary: {
          role_id: role.id,
          linkedin_mode: collected.mode,
          linkedin_profiles_read: collected.profilesRead,
          linkedin_pages_opened: collected.pagesOpened,
          linkedin_budget_left: Math.max(0, remaining - collected.profilesRead),
          capped: collected.capped,
          found: found.length,
        },
      });
    }
  };

  // Inside runOp's transaction (dry run: nothing is written).
  apply();

  return { status: 'ok', output: { found, capped: collected.capped }, eventIds };
};

export type { PeopleDeps };
