import {
  type Contact,
  type ContactLink,
  type LinkedInProvenance,
  type LinkedInSkipReason,
  PeopleFindHint,
  peopleFind,
} from '@perfect-placement/contracts';
import { z } from 'zod';
import { type CollectResult, canonicalProfileUrl, type Degree } from '../integrations/linkedin/index.js';
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

/**
 * People the connect skill found (judgment): named in the JD or on the team page, named by the user, or
 * read on LinkedIn by the agent via Claude in Chrome (`source: 'linkedin'`, #82). Lane H keeps only name,
 * headline, profile URL, email and relationship (degree, via mutual, hiring-team signal).
 */
export const PersonHint = PeopleFindHint.extend({
  name: z.string().min(1).max(120),
  headline: z.string().max(200).nullable().optional(),
});
export type PersonHint = z.infer<typeof PersonHint>;

export const PeopleFindInput = peopleFind.input.extend({
  hints: z.array(PersonHint).max(60).optional(),
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
  hiringTeam: boolean;
}

/** LinkedIn hints the engine kept and the summary it records (#82). */
interface AgentLinkedIn {
  kept: PersonHint[];
  rejected: number;
  /** Profiles counted against the daily budget: distinct people plus their via mutuals. */
  profiles: number;
  capped: boolean;
  overPageCap: boolean;
}

/**
 * Applies lane H's rules to the agent's LinkedIn hints: config mode must be `live`, every profile URL
 * must be a linkedin.com `/in/<slug>` URL (canonicalized), at most `remaining` profiles today (each
 * person and each new via mutual counts), via kept for at most `max_mutual_expansions` 2nd-degree people.
 */
function screenLinkedInHints(
  hints: readonly PersonHint[],
  opts: { live: boolean; remaining: number; maxExpansions: number; maxPages: number; pagesOpened: number },
): AgentLinkedIn {
  const out: AgentLinkedIn = { kept: [], rejected: 0, profiles: 0, capped: false, overPageCap: opts.pagesOpened > opts.maxPages };
  if (!opts.live) return { ...out, rejected: hints.length };
  const counted = new Set<string>();
  let expansions = 0;
  for (const h of hints) {
    const url = h.linkedin_url ? canonicalProfileUrl(h.linkedin_url) : null;
    if (!url) {
      out.rejected++;
      continue;
    }
    let via = h.via ? { ...h.via, linkedin_url: canonicalProfileUrl(h.via.linkedin_url) } : null;
    if (via && (!via.linkedin_url || h.degree !== '2' || expansions >= opts.maxExpansions)) via = null;
    const cost = [url, via?.linkedin_url].filter((u): u is string => !!u && !counted.has(u));
    if (new Set(cost).size > opts.remaining - out.profiles) {
      out.rejected++;
      out.capped = true;
      continue;
    }
    for (const u of cost) counted.add(u);
    out.profiles = counted.size;
    if (via) expansions++;
    out.kept.push({ ...h, linkedin_url: url, via: via ? { ...via, linkedin_url: via.linkedin_url as string } : null });
  }
  if (out.overPageCap) out.capped = true;
  return out;
}

/** Source + confidence of an address people.find saw (#37): Gmail, LinkedIn, the JD or a public page. */
export function knownEmail(email: string | null, source: Contact['source']): Pick<Contact, 'email_source' | 'email_confidence'> {
  if (!email) return { email_source: null, email_confidence: null };
  const s = source === 'jd' || source === 'company_site' ? 'public' : source;
  return { email_source: s, email_confidence: KNOWN_CONFIDENCE[s] };
}

const EMPTY_COLLECT = (capped: boolean): CollectResult => ({ people: [], profilesRead: 0, pagesOpened: 0, capped, mode: 'dry-run' });

/**
 * people.find: the agent's LinkedIn read (hints with `source: 'linkedin'`, #82; read-only, capped), the
 * recorded LinkedIn adapter in tests, Gmail contacts at the company domain, and other skill hints.
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
  const li = deps.config.linkedin;
  const remaining = Math.max(0, li.max_profiles_per_day - linkedinReadsOn(db, ctx.now()));

  // #82: the agent's own LinkedIn read (Claude in Chrome) arrives as hints; it counts first against the budget.
  const liHints = (input.hints ?? []).filter((h) => h.source === 'linkedin');
  const pagesOpened = input.linkedin?.pages_opened ?? 0;
  const agent = screenLinkedInHints(liHints, {
    live: li.mode === 'live',
    remaining,
    maxExpansions: li.max_mutual_expansions,
    maxPages: li.max_pages_per_run,
    pagesOpened,
  });
  const agentRead = li.mode === 'live' && (agent.kept.length > 0 || pagesOpened > 0);

  let collected: CollectResult = EMPTY_COLLECT(false);
  const adapterBudget = remaining - agent.profiles;
  if (deps.linkedin && li.mode !== 'off') {
    collected =
      adapterBudget > 0
        ? await deps.linkedin.collect({
            companyName: company.name,
            companyLinkedInSlug: input.linkedin_company_slug ?? company.slug,
            roleTitle: role.title,
            maxProfiles: adapterBudget,
            maxPages: li.max_pages_per_run,
            maxMutualExpansions: li.max_mutual_expansions,
          })
        : EMPTY_COLLECT(true);
  }
  const profilesRead = agent.profiles + collected.profilesRead;
  const capped = agent.capped || collected.capped;
  const mode: LinkedInProvenance = li.mode === 'off' ? 'off' : agentRead ? 'agent' : 'dry-run';
  const linkedinPeople = agent.kept.length + collected.people.length;
  const reason = ((): LinkedInSkipReason | null => {
    if (mode === 'agent') return null;
    if (li.mode === 'off') return 'off';
    if (li.mode === 'dry-run' || deps.linkedin) return 'dry_run';
    if (input.linkedin?.skipped) return input.linkedin.skipped;
    if (liHints.length) return agent.capped || remaining === 0 ? 'capped' : 'invalid';
    return 'not_reported';
  })();
  const linkedinOut = {
    mode,
    people: linkedinPeople,
    rejected: agent.rejected,
    budget_left: Math.max(0, remaining - profilesRead),
    reason,
  };

  const candidates: Candidate[] = collected.people.map((p) => ({
    name: p.name,
    headline: p.headline,
    linkedin_url: p.url,
    email: null,
    source: 'linkedin',
    degree: p.degree,
    via: p.via,
    hiringTeam: false,
  }));
  if (deps.gmailContacts && company.domain) {
    for (const g of await deps.gmailContacts.searchByDomain(company.domain)) {
      candidates.push({
        name: g.name,
        headline: null,
        linkedin_url: null,
        email: g.email,
        source: 'gmail',
        degree: '1',
        via: null,
        hiringTeam: false,
      });
    }
  }
  for (const h of [...agent.kept, ...(input.hints ?? []).filter((x) => x.source !== 'linkedin')]) {
    const fromLinkedIn = h.source === 'linkedin';
    candidates.push({
      name: h.name,
      headline: h.headline ?? null,
      linkedin_url: h.linkedin_url ?? null,
      email: h.email ?? null,
      source: h.source,
      degree: fromLinkedIn ? (h.degree ?? 'cold') : 'cold',
      via: fromLinkedIn && h.via ? { name: h.via.name, headline: h.via.headline ?? null, url: h.via.linkedin_url } : null,
      hiringTeam: h.hiring_team === true,
    });
  }

  const found: Array<{ contact: Contact; link: ContactLink }> = [];
  const eventIds: string[] = [];
  const seen = new Set<string>();

  /** Resolve or create a contact row. In dry run, nothing is written and ids are placeholders. */
  const resolveContact = (c: Omit<Candidate, 'degree' | 'via' | 'hiringTeam'>): { contact: Contact; created: boolean } => {
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
        const closer = rank[cand.degree] < rank[link.degree];
        // A hiring-team signal (LinkedIn "hiring team", #82) only ever adds; it never clears an earlier call.
        const hiring = link.is_hiring_team || cand.hiringTeam;
        if (closer || hiring !== link.is_hiring_team) {
          const degree = closer ? cand.degree : link.degree;
          link = {
            ...link,
            degree,
            via_contact_id: closer ? (viaId ?? link.via_contact_id) : link.via_contact_id,
            is_hiring_team: hiring,
            tier: tierFor(degree, hiring),
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
          tier: tierFor(cand.degree, cand.hiringTeam),
          via_contact_id: viaId,
          is_hiring_team: cand.hiringTeam,
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
        status: capped ? 'partial' : 'ok',
        summary: {
          role_id: role.id,
          // #82: honest provenance. `agent` = people the agent read on LinkedIn via Claude in Chrome.
          linkedin_mode: mode,
          linkedin_people: linkedinPeople,
          linkedin_reason: reason,
          linkedin_rejected: agent.rejected,
          linkedin_profiles_read: profilesRead,
          linkedin_pages_opened: pagesOpened + collected.pagesOpened,
          linkedin_budget_left: linkedinOut.budget_left,
          ...(agent.overPageCap ? { linkedin_over_page_cap: true } : {}),
          capped,
          found: found.length,
        },
      });
    }
  };

  // Inside runOp's transaction (dry run: nothing is written).
  apply();

  return { status: 'ok', output: { found, capped, linkedin: linkedinOut }, eventIds };
};

export type { PeopleDeps };
