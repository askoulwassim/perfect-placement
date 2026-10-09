import {
  EMAIL_VERIFIER_KEY_ENV,
  type EmailCandidate,
  type EmailVerifierConfig,
  type EmailVerifyStatus,
} from '@perfect-placement/contracts';
import type { FetchLike } from '../integrations/ats/http.js';

/*
 * Email verification (#99), run before a guessed address goes to Needs you. The domain's MX record is
 * always checked (DNS, `dns.ts`); a verification provider (NeverBounce, ZeroBounce, Hunter) behind the
 * user's own key, read from an environment variable and never stored, checks each candidate mailbox.
 * The provider does the SMTP work on its side: this machine never opens a connection to a mail server.
 * Mechanics only: the HTTP client is injected (tests use a fake, never the network).
 */

/** The fetch the adapters use (`EngineServices.fetch`; the global `fetch` satisfies it). */
export type VerifierFetch = FetchLike;

/** One mailbox check by a provider. */
export interface EmailVerifier {
  readonly name: string;
  verify(email: string): Promise<EmailVerifyStatus>;
}

/** Probability a provider-verified deliverable address gets (above the medium `auto` threshold: no Needs you). */
export const DELIVERABLE_P = 0.97;
/** Candidates checked with the provider at most (each check is a paid credit); the first deliverable one stops it. */
export const MAX_VERIFY = 4;

/** Short label per status (Needs you email cards). */
export const VERIFY_LABEL: Record<EmailVerifyStatus, string> = {
  deliverable: 'Deliverable',
  risky: 'Risky',
  undeliverable: 'Undeliverable',
  catch_all: 'Catch-all',
  unknown: 'Unknown',
};

async function getJson(fetch: VerifierFetch, url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  // Never echo the URL: it carries the key.
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  const body = JSON.parse(await res.text()) as unknown;
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
}

const str = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');

/** NeverBounce single check (`result`: valid, invalid, disposable, catchall, unknown). */
export function neverBounce(key: string, fetch: VerifierFetch): EmailVerifier {
  const map: Record<string, EmailVerifyStatus> = {
    valid: 'deliverable',
    invalid: 'undeliverable',
    disposable: 'risky',
    catchall: 'catch_all',
    unknown: 'unknown',
  };
  return {
    name: 'neverbounce',
    async verify(email) {
      const q = new URLSearchParams({ key, email });
      const b = await getJson(fetch, `https://api.neverbounce.com/v4/single/check?${q}`);
      if (str(b.status) !== 'success') throw new Error(`neverbounce: ${str(b.status) || 'error'}`);
      return map[str(b.result)] ?? 'unknown';
    },
  };
}

/** ZeroBounce validate (`status`: valid, invalid, catch-all, unknown, spamtrap, abuse, do_not_mail). */
export function zeroBounce(key: string, fetch: VerifierFetch): EmailVerifier {
  const map: Record<string, EmailVerifyStatus> = {
    valid: 'deliverable',
    invalid: 'undeliverable',
    'catch-all': 'catch_all',
    unknown: 'unknown',
    spamtrap: 'risky',
    abuse: 'risky',
    do_not_mail: 'risky',
  };
  return {
    name: 'zerobounce',
    async verify(email) {
      const q = new URLSearchParams({ api_key: key, email });
      const b = await getJson(fetch, `https://api.zerobounce.net/v2/validate?${q}`);
      if (typeof b.error === 'string') throw new Error('zerobounce: error');
      return map[str(b.status)] ?? 'unknown';
    },
  };
}

/** Hunter email verifier (`data.status`: valid, invalid, accept_all, webmail, disposable, unknown). */
export function hunter(key: string, fetch: VerifierFetch): EmailVerifier {
  const map: Record<string, EmailVerifyStatus> = {
    valid: 'deliverable',
    invalid: 'undeliverable',
    accept_all: 'catch_all',
    webmail: 'risky',
    disposable: 'risky',
    unknown: 'unknown',
  };
  return {
    name: 'hunter',
    async verify(email) {
      const q = new URLSearchParams({ email, api_key: key });
      const b = await getJson(fetch, `https://api.hunter.io/v2/email-verifier?${q}`);
      const data = (b.data ?? {}) as Record<string, unknown>;
      return map[str(data.status)] ?? 'unknown';
    },
  };
}

const ADAPTERS = { neverbounce: neverBounce, zerobounce: zeroBounce, hunter } as const;

/**
 * The configured provider, or null (`none`, no config, or no key in the environment variable). The key
 * is read from `env[keyEnv]` (default per provider, `EMAIL_VERIFIER_KEY_ENV`) at call time only.
 */
export function createEmailVerifier(
  cfg: EmailVerifierConfig | undefined,
  env: Record<string, string | undefined>,
  fetch: VerifierFetch,
): EmailVerifier | null {
  if (!cfg || cfg.provider === 'none') return null;
  const key = env[cfg.keyEnv || EMAIL_VERIFIER_KEY_ENV[cfg.provider]]?.trim();
  return key ? ADAPTERS[cfg.provider](key, fetch) : null;
}

export interface VerifiedCandidates {
  candidates: EmailCandidate[];
  /** Addresses the provider found undeliverable (dropped). */
  dropped: string[];
}

/**
 * Check the ranked candidates. Each gets `verify` (the MX result; `unknown` without a provider). With a
 * provider and a domain that has mail (MX not `false`), candidates are checked in rank order until one
 * is deliverable (at most MAX_VERIFY): deliverable raises p to DELIVERABLE_P, undeliverable drops the
 * candidate, risky / catch-all / unknown leave p as ranked. A provider failure counts as `unknown`.
 */
export async function verifyCandidates(
  ranked: readonly EmailCandidate[],
  mx: boolean | null,
  verifier: EmailVerifier | null | undefined,
): Promise<VerifiedCandidates> {
  const out: EmailCandidate[] = [];
  const dropped: string[] = [];
  let checked = 0;
  let found = false;
  for (const c of ranked) {
    if (verifier && mx !== false && !found && checked < MAX_VERIFY) {
      checked++;
      let status: EmailVerifyStatus;
      try {
        status = await verifier.verify(c.email);
      } catch {
        status = 'unknown';
      }
      if (status === 'undeliverable') {
        dropped.push(c.email);
        continue;
      }
      if (status === 'deliverable') found = true;
      out.push({ ...c, p: status === 'deliverable' ? Math.max(c.p, DELIVERABLE_P) : c.p, verify: { status, mx, provider: verifier.name } });
      continue;
    }
    out.push({ ...c, verify: { status: 'unknown', mx, provider: null } });
  }
  return { candidates: out.sort((a, b) => b.p - a.p), dropped };
}
