import { type AshbyBoard, ashbyBoardUrl, toPosting as ashbyPosting } from './ashby.js';
import { toPosting as greenhousePosting } from './greenhouse.js';
import { type FetchLike, getJson } from './http.js';
import { toPosting as leverPosting } from './lever.js';
import type { AtsPosting } from './types.js';

/*
 * Whole-board listings (#28): every open posting on a company's Greenhouse, Lever or Ashby board in
 * one public API call, JD included. Scout's watchlist scan and the aggregator resolver (#32) use them.
 */

export type BoardType = 'greenhouse' | 'lever' | 'ashby';
export const BOARD_TYPES: readonly BoardType[] = ['greenhouse', 'lever', 'ashby'];

export interface BoardRef {
  type: BoardType;
  board: string;
  region?: 'us' | 'eu';
}

/** A posting from a board listing; `comp` only when the ATS publishes a salary range (Lever). */
export interface ListedPosting extends AtsPosting {
  comp: { min: number; max: number; currency: string } | null;
}

/**
 * `ok`: the board answered (possibly with zero postings). `missing`: the ATS says there is no such
 * board. `error`: anything else (rate limit, 5xx, network, unexpected shape): nothing can be inferred.
 */
export type BoardListing =
  | { state: 'ok'; ref: BoardRef; endpoint: string; postings: ListedPosting[] }
  | { state: 'missing'; ref: BoardRef; endpoint: string; status: number }
  | { state: 'error'; ref: BoardRef; endpoint: string; status: number; reason: string };

const enc = encodeURIComponent;

export function boardListUrl(ref: BoardRef): string {
  const eu = ref.region === 'eu';
  switch (ref.type) {
    case 'greenhouse':
      return `${eu ? 'https://boards-api.eu.greenhouse.io' : 'https://boards-api.greenhouse.io'}/v1/boards/${enc(ref.board)}/jobs?content=true`;
    case 'lever':
      return `${eu ? 'https://api.eu.lever.co' : 'https://api.lever.co'}/v0/postings/${enc(ref.board)}?mode=json`;
    case 'ashby':
      return `${ashbyBoardUrl(ref.board)}?includeCompensation=true`;
  }
}

/** The public posting URL a board ref + job id implies (when the API omits one). */
export function postingUrl(ref: BoardRef, jobId: string): string {
  switch (ref.type) {
    case 'greenhouse':
      return `https://job-boards${ref.region === 'eu' ? '.eu' : ''}.greenhouse.io/${ref.board}/jobs/${jobId}`;
    case 'lever':
      return `https://jobs${ref.region === 'eu' ? '.eu' : ''}.lever.co/${ref.board}/${jobId}`;
    case 'ashby':
      return `https://jobs.ashbyhq.com/${ref.board}/${jobId}`;
  }
}

/** Workplace from an explicit ATS field, else from location text ("Remote - US", "Hybrid - London"). */
export function inferWorkplace(explicit: string | null, location: string | null): string | null {
  const w = explicit?.toLowerCase().replace(/[^a-z]/g, '') ?? '';
  if (w === 'remote' || w === 'hybrid') return w;
  if (w === 'onsite' || w === 'inoffice' || w === 'office') return 'onsite';
  const l = (location ?? '').toLowerCase();
  if (/\bhybrid\b/.test(l)) return 'hybrid';
  if (/\bremote\b/.test(l)) return 'remote';
  if (/\b(on-?site|in[- ]office)\b/.test(l)) return 'onsite';
  return null;
}

interface LeverSalary {
  salaryRange?: { min?: number; max?: number; currency?: string } | null;
}

function leverComp(p: LeverSalary): ListedPosting['comp'] {
  const s = p.salaryRange;
  if (!s || typeof s.min !== 'number' || typeof s.max !== 'number' || !s.currency || s.currency.length !== 3) return null;
  return { min: Math.round(s.min), max: Math.round(s.max), currency: s.currency.toUpperCase() };
}

function finish(ref: BoardRef, p: AtsPosting, comp: ListedPosting['comp'] = null): ListedPosting {
  return { ...p, url: p.url ?? postingUrl(ref, p.jobId), workplace: inferWorkplace(p.workplace, p.location), comp };
}

/** List every open posting on one board. Never throws. */
export async function listBoard(ref: BoardRef, fetchFn: FetchLike): Promise<BoardListing> {
  const endpoint = boardListUrl(ref);
  const res = await getJson<unknown>(fetchFn, endpoint);
  if (!res.ok) {
    // Greenhouse answers a missing board with 404 "Job not found"; Lever 404 "Document not found"; Ashby 404 "Not Found".
    if (res.status === 404) return { state: 'missing', ref, endpoint, status: 404 };
    const reason = 'error' in res ? res.error : `status ${res.status}`;
    return { state: 'error', ref, endpoint, status: res.status, reason };
  }
  const body = res.body as Record<string, unknown> | unknown[] | null;
  const bad = (): BoardListing => ({ state: 'error', ref, endpoint, status: res.status, reason: 'unexpected shape' });
  switch (ref.type) {
    case 'greenhouse': {
      const jobs = body && !Array.isArray(body) ? body.jobs : null;
      if (!Array.isArray(jobs)) return bad();
      return {
        state: 'ok',
        ref,
        endpoint,
        postings: jobs.map((j) => finish(ref, greenhousePosting(j as Parameters<typeof greenhousePosting>[0]))),
      };
    }
    case 'lever': {
      if (!Array.isArray(body)) return bad();
      return {
        state: 'ok',
        ref,
        endpoint,
        postings: body.map((p) => finish(ref, leverPosting(p as Parameters<typeof leverPosting>[0]), leverComp(p as LeverSalary))),
      };
    }
    case 'ashby': {
      const jobs = body && !Array.isArray(body) ? (body as unknown as AshbyBoard).jobs : null;
      if (!Array.isArray(jobs)) return bad();
      return {
        state: 'ok',
        ref,
        endpoint,
        postings: jobs.filter((j) => j.isListed !== false).map((j) => finish(ref, ashbyPosting(j))),
      };
    }
  }
}

/** Memoised board listings for one op call (N lookups on one board cost one request). */
export type BoardCache = Map<string, Promise<BoardListing>>;

export function cachedListBoard(cache: BoardCache, ref: BoardRef, fetchFn: FetchLike): Promise<BoardListing> {
  const key = `${ref.type}:${ref.region ?? 'us'}:${ref.board.toLowerCase()}`;
  let p = cache.get(key);
  if (!p) {
    p = listBoard(ref, fetchFn);
    cache.set(key, p);
  }
  return p;
}
