import type { AtsRef } from './detect.js';
import { decodeEntities, htmlToText } from './html.js';
import { type FetchLike, getJson } from './http.js';
import type { AtsCheck, AtsPosting } from './types.js';

type GreenhouseRef = Extract<AtsRef, { type: 'greenhouse' }>;

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url?: string;
  location?: { name?: string } | null;
  updated_at?: string | null;
  first_published?: string | null;
  /** HTML, entity-escaped once more by the API. */
  content?: string;
}

const host = (ref: GreenhouseRef) => (ref.region === 'eu' ? 'https://boards-api.eu.greenhouse.io' : 'https://boards-api.greenhouse.io');

export const greenhouseJobUrl = (ref: GreenhouseRef) =>
  `${host(ref)}/v1/boards/${encodeURIComponent(ref.board)}/jobs/${encodeURIComponent(ref.jobId)}`;
export const greenhouseBoardUrl = (ref: GreenhouseRef) => `${host(ref)}/v1/boards/${encodeURIComponent(ref.board)}`;

export function toPosting(job: GreenhouseJob): AtsPosting {
  const html = decodeEntities(job.content ?? '');
  return {
    ats: 'greenhouse',
    jobId: String(job.id),
    title: job.title,
    location: job.location?.name ?? null,
    url: job.absolute_url ?? null,
    applyUrl: job.absolute_url ?? null,
    postedAt: job.first_published ?? null,
    updatedAt: job.updated_at ?? null,
    workplace: null,
    html,
    text: htmlToText(html),
  };
}

const errorOf = (body: unknown) => (body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : '');

/**
 * GET /v1/boards/{board}/jobs/{id}: 200 = open. 404 "Job not found" = closed (board alive).
 * 404 "Job board not found" = wrong or retired board: unknown.
 */
export async function checkGreenhouse(ref: GreenhouseRef, fetchFn: FetchLike): Promise<AtsCheck> {
  const endpoint = greenhouseJobUrl(ref);
  const res = await getJson<GreenhouseJob>(fetchFn, endpoint);
  if (res.ok) return { state: 'open', status: res.status, endpoint, posting: toPosting(res.body) };
  if (res.status === 404) {
    const err = errorOf(res.body);
    if (/board not found/i.test(err)) return { state: 'unknown', status: 404, endpoint, reason: 'greenhouse board not found' };
    if (/job not found/i.test(err)) return { state: 'closed', status: 404, endpoint, reason: 'greenhouse api: job not found' };
    // Unrecognised 404 body: confirm the board is alive before calling it closed.
    const board = await getJson<unknown>(fetchFn, greenhouseBoardUrl(ref));
    return board.ok
      ? { state: 'closed', status: 404, endpoint, reason: 'greenhouse api: job 404 on a live board' }
      : { state: 'unknown', status: 404, endpoint, reason: 'greenhouse board not reachable' };
  }
  return { state: 'unknown', status: res.status, endpoint, reason: `greenhouse api status ${res.status}` };
}
