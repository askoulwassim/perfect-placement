import { checkPage } from '../freshness/page.js';
import {
  type AtsClient,
  type AtsHint,
  type AtsPosting,
  type BoardCache,
  createAtsClient,
  detectAts,
  type FetchLike,
  type ListedPosting,
} from '../integrations/ats/index.js';
import { titleSimilarity } from '../ops/dedupe.js';
import { aggregatorOf } from './aggregator.js';
import { type CompanyHint, findBoard } from './boards.js';

/*
 * Intake check for `roles.add` (#32). Mechanics only:
 * - an aggregator URL is resolved to the company's own ATS posting by title, else skipped;
 * - an ATS posting is checked through the ATS API (open / closed), anything else through the page
 *   check (404/410, redirect to a listing, closed phrase); dead postings are skipped;
 * - a bot wall or network failure keeps the role with freshness `unsure`.
 */

/** Title similarity at or above which an ATS posting is the aggregator hit's job. */
export const RESOLVE_TITLE_MIN = 0.7;

export type IntakeVerdict =
  | {
      verdict: 'keep';
      freshness: 'open' | 'unsure' | 'unknown';
      reason: string;
      /** The company's own posting when the hit was an aggregator (or the ATS canonical URL). */
      url?: string;
      ats_job_id?: string;
      /** Original aggregator URL this was resolved from. */
      resolved_from?: string;
      posting?: AtsPosting | ListedPosting;
    }
  | { verdict: 'dead'; reason: string }
  | { verdict: 'aggregator'; reason: string };

export interface IntakeCandidate {
  title: string;
  url?: string | undefined;
  location?: string | undefined;
}

export interface IntakeDeps {
  fetch: FetchLike;
  ats: AtsClient;
  boards: BoardCache;
}

export function intakeDeps(fetchFn: FetchLike): IntakeDeps {
  return { fetch: fetchFn, ats: createAtsClient(fetchFn), boards: new Map() };
}

/** Best title match on a listing; ties broken by location overlap with the hit. */
export function matchPosting<P extends { title: string; location: string | null }>(
  postings: readonly P[],
  title: string,
  location?: string,
): P | null {
  let best: { p: P; sim: number; loc: number } | null = null;
  const locTokens = new Set(
    (location ?? '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean),
  );
  for (const p of postings) {
    const sim = titleSimilarity(title, p.title);
    if (sim < RESOLVE_TITLE_MIN) continue;
    const loc = (p.location ?? '')
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((t) => t && locTokens.has(t)).length;
    if (!best || sim > best.sim || (sim === best.sim && loc > best.loc)) best = { p, sim, loc };
  }
  return best?.p ?? null;
}

export async function verifyCandidate(c: IntakeCandidate, company: CompanyHint, deps: IntakeDeps): Promise<IntakeVerdict> {
  const url = c.url;
  if (!url) return { verdict: 'keep', freshness: 'unknown', reason: 'no url' };

  const agg = aggregatorOf(url);
  if (agg) {
    const search = await findBoard(company, deps.fetch, deps.boards);
    if (!search.found) {
      return {
        verdict: 'aggregator',
        reason: `${agg} link; no ATS board found for ${company.slug}${search.errors.length ? ` (${search.errors.join('; ')})` : ''}`,
      };
    }
    const { ref, postings } = search.found;
    const hit = matchPosting(postings, c.title, c.location);
    if (!hit) return { verdict: 'aggregator', reason: `${agg} link; no matching posting on ${ref.type}:${ref.board}` };
    return {
      verdict: 'keep',
      freshness: 'open',
      reason: `resolved from ${agg} to ${ref.type}:${ref.board}`,
      ...(hit.url ? { url: hit.url } : {}),
      ats_job_id: hit.jobId,
      resolved_from: url,
      posting: hit,
    };
  }

  const hint: AtsHint = { ats_type: (company.ats_type ?? null) as AtsHint['ats_type'], ats_board: company.ats_board ?? null };
  const ref = detectAts(url, hint);
  let atsNote = '';
  if (ref) {
    const res = await deps.ats.check(ref);
    if (res.state === 'open')
      return { verdict: 'keep', freshness: 'open', reason: `${ref.type} api: open`, ats_job_id: res.posting.jobId, posting: res.posting };
    if (res.state === 'closed') return { verdict: 'dead', reason: res.reason };
    atsNote = `${res.reason}; `;
  }
  const page = await checkPage(url, deps.fetch, 0);
  if (page.signal === 'closed') return { verdict: 'dead', reason: `${atsNote}${page.reason}` };
  if (page.blocked) return { verdict: 'keep', freshness: 'unsure', reason: `${atsNote}${page.reason}` };
  return { verdict: 'keep', freshness: 'unknown', reason: `${atsNote}page loaded, no closed signal` };
}
