/*
 * LinkedIn adapter (lane H, decisions.md #6).
 *
 * Read-only browser automation on the user's own signed-in session. Hard rules, enforced in code:
 * - The driver interface can only OPEN a read URL and READ people cards. It has no click, type,
 *   submit or evaluate method, so the adapter cannot connect, message, follow or send anything.
 * - Every URL is checked against a read-only allowlist before it is opened.
 * - Capped: the caller passes the remaining daily budget (config.linkedin.max_profiles_per_day);
 *   every card read counts as one profile. A page cap bounds navigation per call.
 * - Slow: a randomized delay (min_delay_s .. 2 x min_delay_s) before every page open.
 * - Minimal data: only name, headline, profile URL and relationship (degree, via mutual) leave here.
 *
 * Live reads are agent-side (#82, wave1-decisions #4): the `connect` run has Claude in Chrome (read
 * and navigate tools only) and hands what it read to `people.find` as hints with `source: 'linkedin'`;
 * the engine checks each profile URL (`canonicalProfileUrl`), the daily budget and the per-run caps.
 * There is no engine-side live driver: this adapter runs the recorded driver only (`dry-run`, tests and
 * fixtures). The URL builders and `assertReadOnlyUrl` below are the allowlist the skill follows.
 */

// Lane H owns this folder.
export const OWNER_LANE = 'H' as const;

export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';

/** Relationship labels LinkedIn shows on people cards. */
export type DegreeLabel = '1st' | '2nd' | '3rd+' | 'out_of_network';

/** What the driver reads off one people card. Anything beyond these fields is dropped. */
export interface RawPeopleCard {
  name: string;
  headline?: string | null;
  profileUrl: string;
  degreeLabel: DegreeLabel;
  /** Link to "N mutual connections" for a 2nd-degree card, when shown. */
  mutualsUrl?: string | null;
}

/**
 * The only two capabilities a LinkedIn driver may have. No click, no type, no evaluate.
 * Only the recorded driver exists (#82: live reads happen in the agent session via Claude in Chrome).
 */
export interface LinkedInDriver {
  readonly kind: 'recorded';
  open(url: string): Promise<void>;
  readPeopleCards(): Promise<RawPeopleCard[]>;
}

/** Relationship to the user. `1` = connection, `2` = via a mutual, `cold` = no path. */
export type Degree = '1' | '2' | 'cold';

/** The minimal record that leaves the adapter (lane H "Never store more than..."). */
export interface LinkedInPerson {
  name: string;
  headline: string | null;
  url: string;
  degree: Degree;
  /** For degree 2: the 1st-degree mutual this person is reachable through. */
  via: { name: string; headline: string | null; url: string } | null;
  /** Which read produced the card. */
  found_on: 'connections_search' | 'company_people' | 'mutuals';
}

export interface CollectRequest {
  companyName: string;
  /** LinkedIn company vanity slug; the caller defaults it to the PP company slug. */
  companyLinkedInSlug: string;
  roleTitle: string;
  /** Remaining profiles for today. 0 = read nothing. */
  maxProfiles: number;
  /** Max pages opened in this call (default 6). */
  maxPages?: number;
  /** Max 2nd-degree targets whose mutuals are expanded (default 3). */
  maxMutualExpansions?: number;
}

export interface CollectResult {
  people: LinkedInPerson[];
  profilesRead: number;
  pagesOpened: number;
  /** True when the daily budget or the page cap stopped the read early. */
  capped: boolean;
  mode: 'dry-run';
}

export interface LinkedInSource {
  readonly mode: 'dry-run';
  collect(req: CollectRequest): Promise<CollectResult>;
}

export interface LinkedInAdapterOptions {
  driver: LinkedInDriver;
  mode: 'dry-run';
  /** config.linkedin.min_delay_s */
  minDelayS: number;
  /** Injected for tests; defaults to a no-op (dry-run never sleeps for real). */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests; defaults to Math.random. */
  random?: () => number;
}

// --------------------------------------------------------------- read-only URL guard

/** Paths the adapter may open. Everything else is refused. */
const READ_PATHS: RegExp[] = [/^\/search\/results\/people\/?$/, /^\/company\/[a-z0-9-]+\/people\/?$/];

/** Never opened, even if a future path pattern would match. */
const FORBIDDEN_FRAGMENTS = ['messaging', 'invite', 'invitation', 'connect', 'compose', 'send', 'follow', 'inmail', 'mynetwork'];

export class LinkedInGuardError extends Error {
  constructor(url: string, why: string) {
    super(`LinkedIn guard refused ${url}: ${why}`);
    this.name = 'LinkedInGuardError';
  }
}

/** Throws unless `url` is a read-only LinkedIn people listing. */
export function assertReadOnlyUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new LinkedInGuardError(url, 'not a URL');
  }
  if (u.origin !== LINKEDIN_ORIGIN) throw new LinkedInGuardError(url, 'not linkedin.com');
  // Path only: query values are search keywords (a company may be called "Sendbird").
  const haystack = decodeURIComponent(u.pathname).toLowerCase();
  for (const f of FORBIDDEN_FRAGMENTS) {
    if (haystack.includes(f)) throw new LinkedInGuardError(url, `forbidden fragment "${f}"`);
  }
  if (!READ_PATHS.some((r) => r.test(u.pathname))) throw new LinkedInGuardError(url, 'path not on the read-only allowlist');
}

// --------------------------------------------------------------------- URL builders

/** 1st-degree connections matching the company name. `network=["F"]` = first degree. */
export function connectionsSearchUrl(companyName: string): string {
  const q = new URLSearchParams({ keywords: companyName, network: '["F"]' });
  return `${LINKEDIN_ORIGIN}/search/results/people/?${q.toString()}`;
}

/** The company People page, filtered by keywords from the role title. */
export function companyPeopleUrl(companySlug: string, roleTitle: string): string {
  const q = new URLSearchParams({ keywords: titleKeywords(roleTitle) });
  return `${LINKEDIN_ORIGIN}/company/${companySlug}/people/?${q.toString()}`;
}

const STOP = new Set(['of', 'and', 'the', 'for', 'a', 'an', 'to', 'in', 'senior', 'staff', 'principal', 'lead', 'head', 'sr']);

/** "Principal PM, Data Platform" -> "pm data platform". Function words and seniority dropped. */
export function titleKeywords(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .slice(0, 4)
    .join(' ');
}

// ------------------------------------------------------------------- normalization

/** Canonical profile URL: https://www.linkedin.com/in/<slug>, no query, no trailing slash. */
export function canonicalProfileUrl(raw: string): string | null {
  try {
    const u = new URL(raw, LINKEDIN_ORIGIN);
    if (u.origin !== LINKEDIN_ORIGIN) return null;
    const m = u.pathname.match(/^\/in\/([^/]+)/);
    if (!m?.[1]) return null;
    return `${LINKEDIN_ORIGIN}/in/${decodeURIComponent(m[1]).toLowerCase()}`;
  } catch {
    return null;
  }
}

export function degreeFromLabel(label: DegreeLabel): Degree {
  if (label === '1st') return '1';
  if (label === '2nd') return '2';
  return 'cold';
}

const clean = (s: string | null | undefined, max: number): string | null => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

/** Strips a card to the allowed fields. Returns null for unusable cards (no name, hidden member, no profile URL). */
export function normalizeCard(card: RawPeopleCard, found_on: LinkedInPerson['found_on']): LinkedInPerson | null {
  const name = clean(card.name, 120);
  const url = canonicalProfileUrl(card.profileUrl);
  if (!name || !url || /^linkedin member$/i.test(name)) return null;
  return { name, headline: clean(card.headline, 200), url, degree: degreeFromLabel(card.degreeLabel), via: null, found_on };
}

const RANK: Record<Degree, number> = { '1': 0, '2': 1, cold: 2 };

// ------------------------------------------------------------------------- adapter

/**
 * Reads, in order: 1st-degree connections at the company, the company People page (filtered by the
 * role title), then the mutuals of up to `maxMutualExpansions` 2nd-degree people. Stops at the budget.
 */
export function createLinkedInAdapter(opts: LinkedInAdapterOptions): LinkedInSource {
  // #82: no engine-side live driver. Live LinkedIn reads are the agent's (Claude in Chrome) and arrive as hints.
  if ((opts.mode as string) !== 'dry-run' || opts.driver.kind !== 'recorded')
    throw new Error('the LinkedIn adapter runs the recorded driver in dry-run only; live reads are agent-side (Claude in Chrome)');
  const random = opts.random ?? Math.random;
  const sleep = opts.sleep ?? (async () => {});
  const minMs = Math.max(0, opts.minDelayS) * 1000;

  return {
    mode: opts.mode,
    async collect(req) {
      const maxPages = req.maxPages ?? 6;
      const maxExpand = req.maxMutualExpansions ?? 3;
      let budget = Math.max(0, Math.floor(req.maxProfiles));
      let pagesOpened = 0;
      let profilesRead = 0;
      let capped = false;
      const byUrl = new Map<string, LinkedInPerson>();

      const read = async (url: string): Promise<RawPeopleCard[]> => {
        if (budget <= 0 || pagesOpened >= maxPages) {
          capped = true;
          return [];
        }
        assertReadOnlyUrl(url);
        await sleep(minMs + Math.floor(random() * minMs));
        await opts.driver.open(url);
        pagesOpened++;
        const cards = await opts.driver.readPeopleCards();
        const taken = cards.slice(0, budget);
        if (taken.length < cards.length) capped = true;
        budget -= taken.length;
        profilesRead += taken.length;
        return taken;
      };

      const keep = (p: LinkedInPerson) => {
        const prev = byUrl.get(p.url);
        if (!prev || RANK[p.degree] < RANK[prev.degree]) byUrl.set(p.url, p);
      };

      for (const c of await read(connectionsSearchUrl(req.companyName))) {
        const p = normalizeCard(c, 'connections_search');
        if (p && p.degree === '1') keep(p);
      }

      const second: Array<{ url: string; mutualsUrl: string }> = [];
      for (const c of await read(companyPeopleUrl(req.companyLinkedInSlug, req.roleTitle))) {
        const p = normalizeCard(c, 'company_people');
        if (!p) continue;
        keep(p);
        if (p.degree === '2' && c.mutualsUrl) second.push({ url: p.url, mutualsUrl: c.mutualsUrl });
      }

      for (const { url, mutualsUrl } of second.slice(0, maxExpand)) {
        const cards = await read(mutualsUrl);
        const mutual = cards.map((c) => normalizeCard(c, 'mutuals')).find((m): m is LinkedInPerson => m?.degree === '1');
        const target = byUrl.get(url);
        if (mutual && target && target.degree === '2') target.via = { name: mutual.name, headline: mutual.headline, url: mutual.url };
      }

      return { people: [...byUrl.values()], profilesRead, pagesOpened, capped, mode: opts.mode };
    },
  };
}

export { createRecordedDriver, type Recording, SYNTHETIC_RECORDING } from './recorded.js';
