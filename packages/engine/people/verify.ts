import type { EmailCandidate, EmailCheck, EmailDomainCheck, EmailRisk } from '@perfect-placement/contracts';
import { DISPOSABLE, FREE, ROLE } from './lists/aftership.js';

/*
 * The passive email check (#99), run on every guessed candidate before anyone is asked. No contact with a
 * third-party mail server of any kind: no SMTP connection, no mailbox probing, no verification website.
 * Only:
 * - syntax (an RFC 5322 subset),
 * - the domain's DNS (MX, else an A record; `dns.ts`, injected, so tests use no network),
 * - list-based risk (disposable, role and free-provider lists vendored from AfterShip/email-verifier, MIT),
 * - pattern evidence: real addresses at the domain whose format matches the candidate, and exact matches.
 * Whatever this cannot prove goes to Needs you, where the user checks the address by hand.
 */

/** p of a proven candidate (an exact match, or 2+ agreeing peers): above the medium `auto` threshold. */
export const PROVEN_P = 0.97;
/** Agreeing peers (and no conflicting one) that prove a format. */
export const MIN_PEERS = 2;

const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * RFC 5322 subset: a dot-atom local part (no quoted strings, comments or IP literals), at most 64
 * characters; a domain of LDH labels (at most 63 each, no leading or trailing hyphen) with an alphabetic
 * TLD of 2+ letters, at most 253; the whole address at most 254.
 */
export function isValidSyntax(email: string): boolean {
  if (email.length > 254) return false;
  const at = email.lastIndexOf('@');
  if (at < 1 || at !== email.indexOf('@')) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length > 253) return false;
  if (local.split('.').some((atom) => !ATEXT.test(atom))) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((l) => !LABEL.test(l))) return false;
  return /^[a-z]{2,63}$/i.test(labels[labels.length - 1] as string);
}

/** The domain check from the DNS answer (true: MX or A; false: none; null: lookup failed or off). */
export function domainCheck(email: string, mail: boolean | null): EmailDomainCheck {
  if (!isValidSyntax(email)) return 'invalid';
  return mail === true ? 'ok' : mail === false ? 'no_mx' : 'unknown';
}

/** List-based risk; the first that applies of disposable, role, free (vendored AfterShip lists). */
export function riskOf(email: string): EmailRisk {
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at).toLowerCase().replace(/\+.*$/, '');
  const domain = email.slice(at + 1).toLowerCase();
  if (DISPOSABLE.has(domain)) return 'disposable';
  if (ROLE.has(local)) return 'role';
  if (FREE.has(domain)) return 'free';
  return 'none';
}

/** A real address at the domain and the formats it fits (empty: unknown format). */
export interface Peer {
  address: string;
  fits: readonly string[];
}

export interface CheckInput {
  /** The DNS answer for the candidates' domain. */
  mail: boolean | null;
  /** Real addresses at the domain (not this contact's candidates). */
  peers: readonly Peer[];
  /** Addresses seen exactly (public pages, the user's own mail). */
  exact: ReadonlySet<string>;
  /** Highest p an unproven candidate may keep (below the band that could auto-apply): it goes to Needs you. */
  unprovenMax: number;
}

export interface CheckedCandidates {
  candidates: EmailCandidate[];
  /** Dropped by the check: invalid syntax or a domain with no mail records. */
  dropped: string[];
}

/** One candidate's check; `proven` when an exact match or MIN_PEERS agreeing peers with none conflicting. */
export function checkOne(c: Pick<EmailCandidate, 'email' | 'pattern'>, input: Omit<CheckInput, 'unprovenMax'>) {
  const email = c.email.toLowerCase();
  const agree = input.peers.filter((p) => p.fits.includes(c.pattern)).length;
  const conflict = input.peers.filter((p) => p.fits.length > 0 && !p.fits.includes(c.pattern)).length;
  const check: EmailCheck = {
    domain: domainCheck(email, input.mail),
    risk: riskOf(email),
    pattern_peers: agree,
    public_match: input.exact.has(email),
  };
  const proven = check.risk !== 'disposable' && (check.public_match || (agree >= MIN_PEERS && conflict === 0));
  return { check, proven };
}

/**
 * Check the ranked candidates: drop `invalid` and `no_mx`, raise proven ones to PROVEN_P, cap the rest at
 * `unprovenMax` so they go to Needs you (a finder's `provider` candidate keeps its p). Re-sorted by p.
 */
export function checkCandidates(ranked: readonly EmailCandidate[], input: CheckInput): CheckedCandidates {
  const out: EmailCandidate[] = [];
  const dropped: string[] = [];
  for (const c of ranked) {
    const { check, proven } = checkOne(c, input);
    if (check.domain === 'invalid' || check.domain === 'no_mx') {
      dropped.push(c.email);
      continue;
    }
    const p = proven ? Math.max(c.p, PROVEN_P) : c.pattern === 'provider' ? c.p : Math.min(c.p, input.unprovenMax);
    out.push({ ...c, p, check });
  }
  return { candidates: out.sort((a, b) => b.p - a.p), dropped };
}
