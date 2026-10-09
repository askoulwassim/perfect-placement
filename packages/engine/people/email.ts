import {
  type Contact,
  type EmailCandidate,
  type EmailSource,
  OTHER_OPTION,
  type PolicyOutcome,
  peopleFindEmail,
  thresholdsFor,
  vaultPath,
} from '@perfect-placement/contracts';
import { z } from 'zod';
import { getCompany, getContact, getRole, readVault, stripFrontmatter } from './queries.js';
import { err, type Handler, type PeopleDeps } from './types.js';

/*
 * Contact emails (#37). Known addresses first (the contact's own; hints the agent found in Gmail,
 * LinkedIn contact info or public pages; the JD and dossier). Otherwise pattern inference: learn the
 * company's address format from addresses seen at its domain, rank candidates, check the domain's MX
 * record (never SMTP), and give the top pick a probability. Mechanics only: no network here except
 * the injected MX resolver and the (pinned) provider seam.
 */

export const EMAIL_PATTERNS = ['first.last', 'flast', 'first', 'firstl', 'f.last', 'last'] as const;
export type EmailPattern = (typeof EMAIL_PATTERNS)[number];

/** How often each format shows up at companies (prior; the learned examples move it). Sums to 1. */
export const PATTERN_PRIOR: Record<EmailPattern, number> = {
  'first.last': 0.45,
  flast: 0.2,
  first: 0.15,
  'f.last': 0.08,
  firstl: 0.06,
  last: 0.06,
};

/** Weight of the prior against observed examples: two or three consistent examples reach ~0.9. */
export const PRIOR_WEIGHT = 0.3;
/** No MX record: the domain probably takes no mail. */
export const NO_MX_FACTOR = 0.3;
/** Candidates offered in Needs you (plus `other`). */
export const MAX_OPTIONS = 4;

/** Confidence of an address the user or the agent actually saw. */
export const KNOWN_CONFIDENCE: Record<Exclude<EmailSource, 'pattern' | 'provider'>, number> = {
  gmail: 1,
  linkedin: 1,
  manual: 1,
  public: 0.9,
};

/** Mailboxes that are not a person. */
const ROLE_MAILBOXES = new Set([
  'jobs',
  'careers',
  'career',
  'recruiting',
  'recruitment',
  'talent',
  'hr',
  'people',
  'info',
  'hello',
  'hi',
  'contact',
  'support',
  'help',
  'press',
  'media',
  'sales',
  'team',
  'admin',
  'office',
  'noreply',
  'no-reply',
  'privacy',
  'legal',
  'security',
  'billing',
]);

/** Personal mail providers: never a company domain. */
const FREE_MAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
]);

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** Resolves whether a domain has MX records: true, false (none), null (lookup failed or off). */
export type MxResolver = (domain: string) => Promise<boolean | null>;

/**
 * Optional email finder (Hunter, Apollo, ...) behind a user-supplied key. Pinned for later (#37):
 * no adapter ships; the engine uses one only when `EngineServices.emailProvider` is set.
 */
export interface EmailProvider {
  readonly name: string;
  find(query: { name: string; domain: string }): Promise<{ email: string; confidence: number } | null>;
}

// ------------------------------------------------------------------ names + patterns

export interface NameParts {
  first: string;
  /** Full last name, or null when only an initial is known ("Ana B."). */
  last: string | null;
  lastInitial: string | null;
}

const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof']);
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'phd', 'mba', 'md', 'pmp', 'cfa']);

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** "Dr. María-José O'Neil, PhD" -> { first: "mariajose", last: "oneil" }. Null when no usable first name. */
export function nameParts(name: string): NameParts | null {
  const clean = fold(name)
    .replace(/\([^)]*\)/g, ' ')
    .split(',')[0] as string;
  const tokens = clean
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z.'-]/g, ''))
    .filter((t) => t && !HONORIFICS.has(t.replace(/\./g, '')) && !SUFFIXES.has(t.replace(/\./g, '')));
  const strip = (t: string) => t.replace(/[^a-z]/g, '');
  const first = strip(tokens[0] ?? '');
  if (first.length < 2) return null;
  const lastTok = tokens.length > 1 ? (tokens[tokens.length - 1] as string) : '';
  const last = strip(lastTok);
  if (!last) return { first, last: null, lastInitial: null };
  if (last.length === 1) return { first, last: null, lastInitial: last };
  return { first, last, lastInitial: last[0] as string };
}

/** The local part a format gives for a name, or null when the name lacks what the format needs. */
export function localFor(pattern: EmailPattern, n: NameParts): string | null {
  const f = n.first;
  const l = n.last;
  switch (pattern) {
    case 'first':
      return f;
    case 'firstl':
      return n.lastInitial ? `${f}${n.lastInitial}` : null;
    case 'first.last':
      return l ? `${f}.${l}` : null;
    case 'flast':
      return l ? `${f[0]}${l}` : null;
    case 'f.last':
      return l ? `${f[0]}.${l}` : null;
    case 'last':
      return l;
  }
}

/** The local part, lowercased, without a +tag. */
const localOf = (email: string) => (email.split('@')[0] ?? '').toLowerCase().replace(/\+.*$/, '');
export const domainOf = (email: string) => (email.split('@')[1] ?? '').toLowerCase();

/** Formats that produce this local part for this name. */
export function patternsOf(email: string, n: NameParts): EmailPattern[] {
  const local = localOf(email);
  return EMAIL_PATTERNS.filter((p) => localFor(p, n) === local);
}

/** Formats that name the person by last name (safe to attribute an unnamed address). */
const SPECIFIC: readonly EmailPattern[] = ['first.last', 'flast', 'f.last'];

/** Same person? First names equal and last names (or initials) compatible. */
export function sameName(a: NameParts, b: NameParts): boolean {
  if (a.first !== b.first) return false;
  if (a.last && b.last) return a.last === b.last;
  return !!a.lastInitial && a.lastInitial === b.lastInitial;
}

// ------------------------------------------------------------------ format learning

export interface Seen {
  email: string;
  /** Whose address it is, when known. */
  name?: string | null;
  source: Exclude<EmailSource, 'pattern' | 'provider'>;
}

export interface LearnedFormat {
  /** Per format, how much evidence supports it (an address that fits two formats counts half to each). */
  counts: Record<EmailPattern, number>;
  examples: number;
  /** The best-supported format, or null when nothing was learned. */
  pattern: EmailPattern | null;
}

/**
 * Learn the address format at `domain` from addresses seen there. A named address counts for the formats
 * its name produces; an unnamed one only when its local part matches a known person at the company, else
 * by shape (`a.b` -> first.last, `a.bcd` with a one-letter first part -> f.last) at half weight.
 */
export function learnFormat(seen: readonly Seen[], domain: string, people: readonly string[] = []): LearnedFormat {
  const counts = Object.fromEntries(EMAIL_PATTERNS.map((p) => [p, 0])) as Record<EmailPattern, number>;
  const known = people.map(nameParts).filter((n): n is NameParts => !!n);
  const done = new Set<string>();
  let examples = 0;
  for (const s of seen) {
    const email = s.email.toLowerCase();
    if (domainOf(email) !== domain || done.has(email)) continue;
    const local = localOf(email);
    if (ROLE_MAILBOXES.has(local)) continue;
    done.add(email);
    const named = s.name ? nameParts(s.name) : null;
    let fits: EmailPattern[] = named ? patternsOf(email, named) : [];
    let weight = 1;
    if (!named) {
      for (const n of known) {
        const f = patternsOf(email, n).filter((p) => SPECIFIC.includes(p));
        if (f.length) {
          fits = f;
          break;
        }
      }
      if (!fits.length) {
        const shape = /^([a-z]+)\.([a-z]{2,})$/.exec(local);
        if (shape) fits = [(shape[1] as string).length === 1 ? 'f.last' : 'first.last'];
        weight = 0.5;
      }
    }
    if (!fits.length) continue;
    for (const p of fits) counts[p] += weight / fits.length;
    examples++;
  }
  const best = EMAIL_PATTERNS.reduce<EmailPattern | null>((b, p) => (counts[p] > 0 && (!b || counts[p] > counts[b]) ? p : b), null);
  return { counts, examples, pattern: best };
}

/**
 * Ranked candidates for a name at a domain: posterior per format (prior x PRIOR_WEIGHT + evidence),
 * times NO_MX_FACTOR when the domain has no MX record. Only formats the name can fill.
 */
export function rankCandidates(n: NameParts, domain: string, learned: LearnedFormat, mx: boolean | null): EmailCandidate[] {
  const total = EMAIL_PATTERNS.reduce((a, p) => a + learned.counts[p], 0);
  const out: EmailCandidate[] = [];
  const seen = new Set<string>();
  for (const pattern of EMAIL_PATTERNS) {
    const local = localFor(pattern, n);
    if (!local) continue;
    const email = `${local}@${domain}`;
    if (seen.has(email)) continue;
    seen.add(email);
    let p = (PATTERN_PRIOR[pattern] * PRIOR_WEIGHT + learned.counts[pattern]) / (PRIOR_WEIGHT + total);
    if (mx === false) p *= NO_MX_FACTOR;
    out.push({ email, pattern, p: Math.round(p * 1000) / 1000 });
  }
  return out.sort((a, b) => b.p - a.p);
}

/** Emails in a text (JD, dossier). */
export const emailsIn = (text: string | null | undefined): string[] => [...new Set((text ?? '').match(EMAIL_RE) ?? [])];

/** A company domain named in a dossier ("Website: https://acme.example", "Domain: acme.example"). */
export function dossierDomain(md: string | null | undefined): string | null {
  const m =
    /^[\s*_>-]*(?:website|domain|site|homepage|web)[*_\s]*[:|][\s*_]*(?:<?https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)/im.exec(
      md ?? '',
    );
  return m ? (m[1] as string).toLowerCase() : null;
}

/** "acme.example" -> "acme.example"; strips scheme, www and path. */
export function cleanDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  const host = d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split(/[/?#]/)[0] as string;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

// ------------------------------------------------------------------ draft recipient

export const isKnownSource = (s: EmailSource | null): boolean => s !== null && s !== 'pattern' && s !== 'provider';

/**
 * Should this contact's address go in a Gmail draft's To? Yes when confirmed (manual, or confidence at
 * the `people.email` auto threshold) and no `people.email` decision is waiting on it. A legacy address
 * with no source counts as known.
 */
export function draftRecipient(
  deps: Pick<PeopleDeps, 'repos' | 'config'>,
  c: Contact,
): { email: string | null; guess: string | null; reason: string | null; confirmed: boolean } {
  if (!c.email) return { email: null, guess: null, reason: 'no email found', confirmed: false };
  const pending = deps.repos.decision.select(
    `kind = 'people.email' AND status = 'pending' AND subject_type = 'contact' AND subject_id = ? LIMIT 1`,
    [c.id],
  ).length;
  const auto = thresholdsFor(deps.config, 'people.email').auto;
  const confident = c.email_source === null || c.email_source === 'manual' || (c.email_confidence ?? 0) >= auto;
  if (confident && !pending) return { email: c.email, guess: c.email, reason: null, confirmed: true };
  const pct = Math.round((c.email_confidence ?? 0) * 100);
  return { email: null, guess: c.email, reason: `unconfirmed guess (${pct}%): confirm it in Needs you`, confirmed: false };
}

// ------------------------------------------------------------------ people.find_email

export const PeopleFindEmailInput = peopleFindEmail.input;
export type PeopleFindEmailInput = z.infer<typeof PeopleFindEmailInput>;

const Email = z.string().email();

type Output = {
  contact: Contact;
  email: string | null;
  source: EmailSource | null;
  confidence: number | null;
  confirmed: boolean;
  domain: string | null;
  mx: boolean | null;
  pattern: string | null;
  candidates: EmailCandidate[];
  decision_id: string | null;
  outcome: PolicyOutcome | null;
  reason: string | null;
};

/** The role an email is for: the input, else the contact's latest role link. */
function roleFor(deps: PeopleDeps, contactId: string, roleId?: string) {
  if (roleId) return getRole(deps.repos, roleId);
  const link = deps.repos.contact_link.select('contact_id = ? AND role_id IS NOT NULL ORDER BY id DESC LIMIT 1', [contactId])[0];
  return link?.role_id ? getRole(deps.repos, link.role_id) : undefined;
}

const bodyOf = (deps: PeopleDeps, rel: string | null | undefined): string | null => {
  if (!rel) return null;
  try {
    const md = readVault(deps, rel);
    return md ? stripFrontmatter(md) : null;
  } catch {
    return null;
  }
};

/**
 * people.find_email (#37). Writes only the contact's email, email_source and email_confidence, plus one
 * `people.email` decision when a guess is made (earlier pending ones for the contact expire).
 */
export const findEmail: Handler<'people.find_email'> = async (raw, ctx, deps) => {
  const parsed = PeopleFindEmailInput.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'people.find_email input', parsed.error.issues);
  const input = parsed.data;
  const { repos: db } = deps;
  const contact = getContact(db, input.contact_id);
  if (!contact) return err('not_found', `contact ${input.contact_id}`);
  const role = roleFor(deps, contact.id, input.role_id);
  if (input.role_id && !role) return err('not_found', `role ${input.role_id}`);
  const company = role ? getCompany(db, role.company_id) : undefined;

  const set = (email: string | null, source: EmailSource | null, confidence: number | null): Contact => {
    const next = { ...contact, email, email_source: source, email_confidence: confidence };
    if (!ctx.dryRun) db.contact.update(contact.id, { email, email_source: source, email_confidence: confidence });
    return next;
  };
  const result = (c: Contact, extra: Partial<Output> = {}): Output => {
    const r = draftRecipient(deps, c);
    return {
      contact: c,
      email: c.email,
      source: c.email_source,
      confidence: c.email_confidence,
      confirmed: r.confirmed,
      domain: null,
      mx: null,
      pattern: null,
      candidates: [],
      decision_id: null,
      outcome: null,
      reason: r.reason,
      ...extra,
    };
  };

  // A pick: the human's answer from Needs you (decision action `$value`) or a manual entry.
  if (input.value !== undefined) {
    // An auto-applied decision runs this action too; the main path below stores the pick itself.
    if (ctx.actor !== 'human') {
      if (ctx.decisionId) return { status: 'ok', output: result(contact), eventIds: [] };
      return err('invalid_input', 'value is a human pick; pass addresses you found as hints');
    }
    const value = input.value.trim().toLowerCase();
    if (value === OTHER_OPTION) return err('invalid_input', 'type the address to use');
    if (!Email.safeParse(value).success) return err('invalid_input', `not an email address: ${input.value}`);
    const n = nameParts(contact.name);
    // A pick among the guesses (same domain, fits the name) stays a pattern address, now confirmed.
    const guessDomains = [cleanDomain(company?.domain), contact.email ? domainOf(contact.email) : null];
    const fromPattern =
      !!n && patternsOf(value, n).length > 0 && guessDomains.includes(domainOf(value)) && !isKnownSource(contact.email_source);
    const next = set(value, fromPattern ? 'pattern' : 'manual', 1);
    return { status: 'ok', output: result(next, { domain: domainOf(value) }), eventIds: [] };
  }

  // Already known (seen in mail, on LinkedIn, on a public page, or set by the user): keep it.
  if (contact.email && isKnownSource(contact.email_source ?? 'public'))
    return { status: 'ok', output: result(contact, { domain: domainOf(contact.email) }), eventIds: [] };

  const me = nameParts(contact.name);
  const hints = input.hints ?? [];

  // A hint naming this person is their address.
  for (const h of hints) {
    const hn = h.name ? nameParts(h.name) : null;
    if (me && hn && sameName(me, hn)) {
      const next = set(h.email.toLowerCase(), h.source, KNOWN_CONFIDENCE[h.source]);
      return { status: 'ok', output: result(next, { domain: domainOf(h.email) }), eventIds: [] };
    }
  }

  const jd = role ? bodyOf(deps, role.md_path ?? vaultPath.role(role.id)) : null;
  const dossier = company ? bodyOf(deps, vaultPath.dossier(company.slug)) : null;
  const slug = company?.slug.split('-')[0] ?? '';
  const hintDomain = hints.map((h) => domainOf(h.email)).find((d) => !FREE_MAIL.has(d) && slug.length > 2 && d.includes(slug));
  const domain = cleanDomain(company?.domain) ?? cleanDomain(input.domain) ?? dossierDomain(dossier) ?? cleanDomain(hintDomain) ?? null;
  if (!domain || !me) {
    const reason = !domain ? 'no company domain: pass domain' : 'name too short to guess';
    return { status: 'ok', output: result(contact, { domain, reason }), eventIds: [] };
  }

  // Addresses seen at the company: its known contacts, the JD, the dossier, and the agent's hints.
  const peers = company
    ? db.contact
        .select(`email IS NOT NULL AND id <> ? AND id IN (SELECT contact_id FROM contact_link WHERE company_id = ?)`, [
          contact.id,
          company.id,
        ])
        .filter((c) => isKnownSource(c.email_source ?? 'public'))
    : [];
  const seen: Seen[] = [
    ...peers.map((c) => ({ email: c.email as string, name: c.name, source: 'public' as const })),
    ...hints.map((h) => ({ email: h.email, name: h.name ?? null, source: h.source })),
    ...emailsIn(jd).map((email) => ({ email, source: 'public' as const })),
    ...emailsIn(dossier).map((email) => ({ email, source: 'public' as const })),
  ];

  // An unnamed address at the domain that spells this person's full name is theirs.
  for (const s of seen) {
    if (s.name || domainOf(s.email) !== domain) continue;
    if (patternsOf(s.email, me).some((p) => SPECIFIC.includes(p))) {
      const next = set(s.email.toLowerCase(), s.source, KNOWN_CONFIDENCE[s.source]);
      return { status: 'ok', output: result(next, { domain }), eventIds: [] };
    }
  }

  const people = company
    ? db.contact.select(`id IN (SELECT contact_id FROM contact_link WHERE company_id = ?)`, [company.id]).map((c) => c.name)
    : [];
  const learned = learnFormat(seen, domain, people);
  let mx: boolean | null = null;
  if (deps.mx) {
    try {
      mx = await deps.mx(domain);
    } catch {
      mx = null;
    }
  }
  let candidates = rankCandidates(me, domain, learned, mx);
  if (deps.emailProvider) {
    try {
      const found = await deps.emailProvider.find({ name: contact.name, domain });
      if (found && Email.safeParse(found.email).success) {
        const email = found.email.toLowerCase();
        const p = Math.max(0, Math.min(1, found.confidence));
        const same = candidates.find((c) => c.email === email);
        candidates = [
          ...candidates.filter((c) => c.email !== email),
          { email, pattern: same && same.p >= p ? same.pattern : 'provider', p: Math.max(p, same?.p ?? 0) },
        ].sort((a, b) => b.p - a.p);
      }
    } catch {
      // A provider failure leaves the pattern guess.
    }
  }
  const top = candidates[0];
  const extra = { domain, mx, pattern: learned.pattern, candidates };
  if (!top) return { status: 'ok', output: result(contact, extra), eventIds: [] };
  const source: EmailSource = top.pattern === 'provider' ? 'provider' : 'pattern';
  if (ctx.dryRun) {
    const guess = { ...contact, email: top.email, email_source: source, email_confidence: top.p };
    return { status: 'ok', output: result(guess, extra), eventIds: [] };
  }

  // Earlier pending picks for this contact are replaced by this one.
  const now = ctx.now().toISOString();
  for (const d of db.decision.select(`kind = 'people.email' AND status = 'pending' AND subject_type = 'contact' AND subject_id = ?`, [
    contact.id,
  ]))
    db.decision.update(d.id, { status: 'expired', resolved_at: now });

  const options = candidates.slice(0, MAX_OPTIONS).map((c) => c.email);
  let r: Awaited<ReturnType<PeopleDeps['record']>>;
  try {
    r = await deps.record({
      decision: 'people.email',
      impact: 'medium',
      subject: { type: 'contact', id: contact.id },
      question: {
        id: 'email',
        type: 'choice',
        instructions: `Use ${top.email} for ${contact.name}?`,
        options: [...options, OTHER_OPTION],
        name: contact.name,
        domain,
        mx,
        pattern: learned.pattern,
        examples: learned.examples,
        candidates: candidates.slice(0, MAX_OPTIONS),
      },
      answer: { id: 'email', value: top.email, p: top.p },
      backend: 'rule',
      action: { op: 'people.find_email', input: { contact_id: contact.id, ...(role ? { role_id: role.id } : {}), value: '$value' } },
    });
  } catch (e) {
    return err('backend_unavailable', `resolver: ${(e as Error).message}`);
  }
  // Stored either way: confident = confirmed; otherwise an unconfirmed guess until the user picks.
  const next = set(top.email, source, top.p);
  return { status: 'ok', output: result(next, { ...extra, decision_id: r.decisionId, outcome: r.outcome }), eventIds: [] };
};
