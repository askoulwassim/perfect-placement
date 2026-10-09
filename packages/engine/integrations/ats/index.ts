// Lane G. ATS public posting APIs (Greenhouse, Lever, Ashby), URL detection, JD capture.
import { type AshbyBoardCache, checkAshby } from './ashby.js';
import { type AtsHint, type AtsRef, detectAts } from './detect.js';
import { checkGreenhouse } from './greenhouse.js';
import { htmlToText, pageTitle } from './html.js';
import type { FetchLike } from './http.js';
import { checkLever } from './lever.js';
import type { AtsCheck, AtsPosting } from './types.js';

export const OWNER_LANE = 'G' as const;

export { type AshbyBoardCache, ashbyBoardUrl, checkAshby } from './ashby.js';
export { type AtsHint, type AtsRef, atsTypeOf, detectAts } from './detect.js';
export { checkGreenhouse, greenhouseBoardUrl, greenhouseJobUrl } from './greenhouse.js';
export { decodeEntities, htmlToText, pageTitle } from './html.js';
export { DEFAULT_TIMEOUT_MS, defaultFetch, type FetchLike, getJson, type HttpInit, type HttpResponse, USER_AGENT } from './http.js';
export { checkLever, leverBoardUrl, leverPostingUrl } from './lever.js';
export {
  BOARD_TYPES,
  type BoardCache,
  type BoardListing,
  type BoardRef,
  type BoardType,
  boardListUrl,
  cachedListBoard,
  inferWorkplace,
  type ListedPosting,
  listBoard,
  postingUrl,
} from './list.js';
export type { AtsCheck, AtsPosting } from './types.js';

export interface AtsClient {
  check(ref: AtsRef): Promise<AtsCheck>;
}

/** One client per run: memoises Ashby board lists so N roles on one board cost one call. */
export function createAtsClient(fetchFn: FetchLike): AtsClient {
  const ashbyCache: AshbyBoardCache = new Map();
  return {
    check(ref) {
      switch (ref.type) {
        case 'greenhouse':
          return checkGreenhouse(ref, fetchFn);
        case 'lever':
          return checkLever(ref, fetchFn);
        case 'ashby':
          return checkAshby(ref, fetchFn, ashbyCache);
      }
    },
  };
}

export type JdCapture =
  | { source: 'ats_api'; posting: AtsPosting }
  | { source: 'page'; url: string; title: string | null; text: string; status: number }
  | { source: 'none'; reason: string };

/**
 * Capture the full JD at intake (roles.add) or when the file holds only a header.
 * ATS API first; otherwise the page text (best effort; JS-rendered pages may come back thin).
 */
export async function captureJd(url: string, fetchFn: FetchLike, hint?: AtsHint): Promise<JdCapture> {
  const ref = detectAts(url, hint);
  if (ref) {
    const res = await createAtsClient(fetchFn).check(ref);
    if (res.state === 'open') return { source: 'ats_api', posting: res.posting };
  }
  try {
    const res = await fetchFn(url);
    if (res.status >= 400) return { source: 'none', reason: `page status ${res.status}` };
    const html = await res.text();
    return { source: 'page', url: res.url || url, title: pageTitle(html), text: htmlToText(html), status: res.status };
  } catch (e) {
    return { source: 'none', reason: e instanceof Error ? e.message : String(e) };
  }
}
