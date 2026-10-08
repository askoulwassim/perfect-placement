import type { AtsRef } from './detect.js';
import { htmlToText } from './html.js';
import { type FetchLike, getJson, type JsonResult } from './http.js';
import type { AtsCheck, AtsPosting } from './types.js';

type AshbyRef = Extract<AtsRef, { type: 'ashby' }>;

interface AshbyJob {
  id: string;
  title: string;
  location?: string | null;
  workplaceType?: string | null;
  isListed?: boolean;
  publishedAt?: string | null;
  jobUrl?: string | null;
  applyUrl?: string | null;
  descriptionHtml?: string | null;
  descriptionPlain?: string | null;
}
export interface AshbyBoard {
  jobs: AshbyJob[];
}

export const ashbyBoardUrl = (board: string) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`;

export function toPosting(j: AshbyJob): AtsPosting {
  const html = j.descriptionHtml ?? '';
  return {
    ats: 'ashby',
    jobId: j.id,
    title: j.title,
    location: j.location ?? null,
    url: j.jobUrl ?? null,
    applyUrl: j.applyUrl ?? null,
    postedAt: j.publishedAt ?? null,
    updatedAt: null,
    workplace: j.workplaceType ? j.workplaceType.toLowerCase() : null,
    html,
    text: j.descriptionPlain?.trim() || htmlToText(html),
  };
}

/** Board lists are fetched once per board per run (one call covers every role on that board). */
export type AshbyBoardCache = Map<string, Promise<JsonResult<AshbyBoard>>>;

/**
 * Ashby's public API lists a whole board: GET /posting-api/job-board/{board}. The job present = open;
 * absent from a live board = closed (an unlisted posting may still exist, so the ladder still asks
 * the resolver before archiving). Board 404 = unknown.
 */
export async function checkAshby(ref: AshbyRef, fetchFn: FetchLike, cache?: AshbyBoardCache): Promise<AtsCheck> {
  const endpoint = ashbyBoardUrl(ref.board);
  let pending = cache?.get(ref.board);
  if (!pending) {
    pending = getJson<AshbyBoard>(fetchFn, endpoint);
    cache?.set(ref.board, pending);
  }
  const res = await pending;
  if (!res.ok) {
    return {
      state: 'unknown',
      status: res.status,
      endpoint,
      reason: `ashby board ${res.status === 404 ? 'not found' : `status ${res.status}`}`,
    };
  }
  const jobs = Array.isArray(res.body?.jobs) ? res.body.jobs : null;
  if (!jobs) return { state: 'unknown', status: res.status, endpoint, reason: 'ashby board: unexpected shape' };
  const job = jobs.find((j) => j.id?.toLowerCase() === ref.jobId);
  if (job) return { state: 'open', status: res.status, endpoint, posting: toPosting(job) };
  return { state: 'closed', status: res.status, endpoint, reason: 'ashby api: job absent from live board' };
}
