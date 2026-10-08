import type { AtsRef } from './detect.js';
import { htmlToText } from './html.js';
import { type FetchLike, getJson } from './http.js';
import type { AtsCheck, AtsPosting } from './types.js';

type LeverRef = Extract<AtsRef, { type: 'lever' }>;

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number | string;
  workplaceType?: string;
  categories?: { location?: string; allLocations?: string[] } | null;
  description?: string;
  lists?: Array<{ text: string; content: string }>;
  additional?: string;
}

const host = (ref: LeverRef) => (ref.region === 'eu' ? 'https://api.eu.lever.co' : 'https://api.lever.co');

export const leverPostingUrl = (ref: LeverRef) =>
  `${host(ref)}/v0/postings/${encodeURIComponent(ref.company)}/${encodeURIComponent(ref.postingId)}`;
export const leverBoardUrl = (ref: LeverRef) => `${host(ref)}/v0/postings/${encodeURIComponent(ref.company)}?mode=json&limit=1`;

export function toPosting(p: LeverPosting): AtsPosting {
  const lists = (p.lists ?? []).map((l) => `<h3>${l.text}</h3><ul>${l.content}</ul>`).join('');
  const html = `${p.description ?? ''}${lists}${p.additional ?? ''}`;
  const created = p.createdAt === undefined ? null : new Date(Number(p.createdAt));
  return {
    ats: 'lever',
    jobId: p.id,
    title: p.text,
    location: p.categories?.location ?? null,
    url: p.hostedUrl ?? null,
    applyUrl: p.applyUrl ?? null,
    postedAt: created && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
    updatedAt: null,
    workplace: p.workplaceType ? p.workplaceType.toLowerCase() : null,
    html,
    text: htmlToText(html),
  };
}

/**
 * GET /v0/postings/{company}/{id}: 200 = open. Lever answers 404 "Document not found" both for a
 * missing posting and a missing company, so a 404 is only `closed` when the company board answers.
 */
export async function checkLever(ref: LeverRef, fetchFn: FetchLike): Promise<AtsCheck> {
  const endpoint = leverPostingUrl(ref);
  const res = await getJson<LeverPosting>(fetchFn, endpoint);
  if (res.ok) return { state: 'open', status: res.status, endpoint, posting: toPosting(res.body) };
  if (res.status === 404) {
    const board = await getJson<unknown>(fetchFn, leverBoardUrl(ref));
    return board.ok
      ? { state: 'closed', status: 404, endpoint, reason: 'lever api: posting not found on a live board' }
      : { state: 'unknown', status: 404, endpoint, reason: 'lever company board not found' };
  }
  return { state: 'unknown', status: res.status, endpoint, reason: `lever api status ${res.status}` };
}
