import {
  type ConnectFallback,
  type Contact,
  type ContactLink,
  type ContactSource,
  type OpOutput,
  peopleFallback,
  type TeamInboxHint,
  vaultPath,
} from '@perfect-placement/contracts';
import { cleanDomain, dossierDomain, emailsIn, findEmail, KNOWN_CONFIDENCE } from './email.js';
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
  isPicked,
  newId,
  readVault,
  recordConnectFallback,
  skipConnect,
  stripFrontmatter,
  updateLink,
} from './queries.js';
import { err, type Handler, type PeopleDeps } from './types.js';

/*
 * #78: the no-contact fallback, so a role never stalls in Connect. The agent supplies judgment (the
 * addresses it saw on the JD, careers page, dossier or company site; the likely hiring leader from the
 * dossier); code picks, in order: team inbox -> cold leader (pattern-guessed email, #37) -> skip Connect.
 */

/** Team mailboxes that reach the hiring team, best first. Other role mailboxes (info@, hello@) never do. */
export const TEAM_MAILBOXES = [
  'recruiting',
  'recruitment',
  'recruiter',
  'recruiters',
  'talent',
  'hiring',
  'careers',
  'career',
  'jobs',
  'people',
  'hr',
  'apply',
] as const;

/** Name of a team-inbox contact with no named recruiter. */
export const TEAM_INBOX_NAME = 'Hiring team';

const localOf = (email: string): string => (email.split('@')[0] ?? '').split('+')[0]?.toLowerCase() ?? '';
const domainOf = (email: string): string => (email.split('@')[1] ?? '').toLowerCase();

/** Rank of a team mailbox (0 best), or -1 when the address is not one. */
export function teamMailboxRank(email: string): number {
  return (TEAM_MAILBOXES as readonly string[]).indexOf(localOf(email));
}

/** At the company domain or one of its subdomains (`jobs.acme.example`). Unknown domain: any. */
export function atDomain(email: string, domain: string | null): boolean {
  if (!domain) return true;
  const d = domainOf(email);
  return d === domain || d.endsWith(`.${domain}`);
}

/**
 * The best hiring-team address: a named recruiter at the company domain first, then team mailboxes in
 * TEAM_MAILBOXES order. Addresses at another domain, and role mailboxes that are not a team inbox, are
 * never picked.
 */
export function pickTeamInbox(hints: readonly TeamInboxHint[], domain: string | null): TeamInboxHint | null {
  const rank = (h: TeamInboxHint): number => {
    if (!atDomain(h.email, domain)) return -1;
    if (h.name?.trim()) return 0;
    const r = teamMailboxRank(h.email);
    return r < 0 ? -1 : r + 1;
  };
  return (
    hints
      .map((h, i) => ({ h, r: rank(h), i }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.i - b.i)[0]?.h ?? null
  );
}

const SOURCE: Record<TeamInboxHint['source'], ContactSource> = {
  jd: 'jd',
  careers: 'company_site',
  dossier: 'company_site',
  company_site: 'company_site',
};

const body = (deps: PeopleDeps, rel: string | null | undefined): string | null => {
  if (!rel) return null;
  try {
    const md = readVault(deps, rel);
    return md ? stripFrontmatter(md) : null;
  } catch {
    return null;
  }
};

type Output = OpOutput<'people.fallback'>;

/**
 * people.fallback (#78). Writes at most one contact + its `cold_hiring` link (plus the leader's email
 * guess through people.find_email), or moves the application to Fill; records the fallback used as a
 * run row that roles.get reads back as `connect`.
 */
export const fallbackPeople: Handler<'people.fallback'> = async (raw, ctx, deps) => {
  const parsed = peopleFallback.input.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'people.fallback input', parsed.error.issues);
  const input = parsed.data;
  const { repos: db } = deps;
  const dryRun = Boolean(ctx.dryRun);

  const role = getRole(db, input.role_id);
  if (!role) return err('not_found', `role ${input.role_id}`);
  const company = getCompany(db, role.company_id);
  if (!company) return err('not_found', `company ${role.company_id}`);
  if (!isPicked(db, role)) return err('conflict', `role ${role.id} is not picked; Connect runs on picked roles only`);

  const appOf = () => db.application.list({ role_id: role.id })[0] ?? null;
  const none: Output = { fallback: null, contact: null, link: null, email: null, application: appOf(), reason: null };

  // A usable contact (anything but cold, not hiring team) means no fallback is needed.
  const usable = db.contact_link.select(`role_id = ? AND tier != 'cold_other'`, [role.id]).length;
  if (usable) return { status: 'ok', output: { ...none, reason: `${usable} usable contact${usable === 1 ? '' : 's'}` }, eventIds: [] };

  const jd = body(deps, role.md_path ?? vaultPath.role(role.id));
  const dossier = body(deps, vaultPath.dossier(company.slug));
  const domain = cleanDomain(company.domain) ?? cleanDomain(input.domain) ?? dossierDomain(dossier);
  const at = ctx.now().toISOString();
  const eventIds: string[] = [];

  /** Upsert the fallback contact and its cold_hiring link (dry run: nothing written). */
  const addContact = (
    c: Omit<Contact, 'id' | 'notes'>,
    fallback: Exclude<ConnectFallback, 'skipped'>,
  ): { contact: Contact; link: ContactLink } => {
    const existing = findContact(db, { linkedin_url: c.linkedin_url, email: c.email });
    let contact: Contact;
    let created = false;
    if (existing) contact = dryRun ? existing : fillContact(db, existing, c);
    else {
      contact = { ...c, id: newId(deps, 'ct'), notes: null };
      created = true;
      if (!dryRun) insertContact(db, contact);
    }
    const prev = getLinkForRole(db, contact.id, role.id);
    const link: ContactLink = {
      id: prev?.id ?? newId(deps, 'cl'),
      contact_id: contact.id,
      company_id: company.id,
      role_id: role.id,
      degree: prev?.degree ?? 'cold',
      tier: 'cold_hiring',
      via_contact_id: prev?.via_contact_id ?? null,
      is_hiring_team: true,
      path: prev?.path ?? null,
      via_tie_json: prev?.via_tie_json ?? null,
      team_side: prev?.team_side ?? false,
      brand: prev?.brand ?? null,
    };
    if (!dryRun) {
      if (prev) updateLink(db, link);
      else insertLink(db, link);
      if (!prev)
        eventIds.push(
          emitEvent(deps, {
            type: 'contact_found',
            subject_type: 'contact',
            subject_id: contact.id,
            payload: { role_id: role.id, source: contact.source, degree: 'cold', new_contact: created, fallback },
            actor: ctx.actor,
            ts: at,
          }),
        );
    }
    return { contact, link };
  };
  const record = (fallback: ConnectFallback, reason: string, contactId: string | null) => {
    if (!dryRun)
      recordConnectFallback(db, {
        id: newId(deps, 'rn'),
        op: 'people.fallback',
        at,
        role_id: role.id,
        fallback,
        reason,
        contact_id: contactId,
      });
  };

  // 1. A hiring-team or recruiting address: the agent's hints, then team mailboxes in the JD and dossier.
  const scanned: TeamInboxHint[] = [
    ...emailsIn(jd).map((email) => ({ email, source: 'jd' as const })),
    ...emailsIn(dossier).map((email) => ({ email, source: 'dossier' as const })),
  ].filter((h) => teamMailboxRank(h.email) >= 0);
  const team = pickTeamInbox([...(input.team_inbox ?? []), ...scanned], domain);
  if (team) {
    const named = team.name?.trim();
    const { contact, link } = addContact(
      {
        name: named || TEAM_INBOX_NAME,
        headline: named ? `Recruiting, ${company.name}` : `${company.name} hiring team`,
        linkedin_url: null,
        email: team.email.toLowerCase(),
        source: SOURCE[team.source],
        email_source: 'public',
        email_confidence: KNOWN_CONFIDENCE.public,
      },
      'team_inbox',
    );
    const reason = `${named ? 'recruiter' : localOf(team.email)}@ from ${team.source}`;
    record('team_inbox', reason, contact.id);
    return {
      status: 'ok',
      output: { ...none, fallback: 'team_inbox', contact: dryRun ? contact : (getContact(db, contact.id) ?? contact), link, reason },
      eventIds,
    };
  }

  // 2. A cold note to the likely hiring leader, with a pattern-guessed address (#37; unsure: Needs you).
  if (input.leader) {
    const l = input.leader;
    const { contact, link } = addContact(
      {
        name: l.name,
        headline: l.headline ?? null,
        linkedin_url: l.linkedin_url ?? null,
        email: null,
        source: 'company_site',
        email_source: null,
        email_confidence: null,
      },
      'cold_leader',
    );
    let email: Output['email'] = null;
    if (!dryRun) {
      const found = await findEmail(
        {
          contact_id: contact.id,
          role_id: role.id,
          ...(input.email_hints ? { hints: input.email_hints } : {}),
          ...(domain ? { domain } : {}),
        },
        ctx,
        deps,
      );
      email =
        found.status === 'ok'
          ? {
              email: found.output.email,
              confidence: found.output.confidence,
              confirmed: found.output.confirmed,
              decision_id: found.output.decision_id,
              outcome: found.output.outcome,
              reason: found.output.reason,
            }
          : {
              email: null,
              confidence: null,
              confirmed: false,
              decision_id: null,
              outcome: null,
              reason: found.status === 'error' ? found.message : 'needs you',
            };
    }
    const reason = 'no team inbox found';
    record('cold_leader', reason, contact.id);
    return {
      status: 'ok',
      output: {
        ...none,
        fallback: 'cold_leader',
        contact: dryRun ? contact : (getContact(db, contact.id) ?? contact),
        link,
        email,
        reason,
      },
      eventIds,
    };
  }

  // 3. Skip Connect: the application moves to Fill.
  const reason = input.reason ?? 'no contacts';
  if (dryRun) return { status: 'ok', output: { ...none, fallback: 'skipped', reason }, eventIds };
  const skipped = skipConnect(db, role, () => newId(deps, 'ap'));
  if ('error' in skipped) return err('conflict', skipped.error);
  record('skipped', reason, null);
  return { status: 'ok', output: { ...none, fallback: 'skipped', application: skipped.application, reason }, eventIds };
};
