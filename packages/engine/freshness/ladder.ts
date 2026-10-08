import { type AtsClient, type AtsHint, type AtsRef, detectAts, type FetchLike } from '../integrations/ats/index.js';
import { checkPage } from './page.js';

/** What the mechanical rungs (ATS API, page) found. The resolver rung reads this as state. */
export interface Evidence {
  /** Rung that produced the verdict. */
  method: 'ats_api' | 'page';
  verdict: 'open' | 'closed' | 'inconclusive';
  reason: string;
  ats: AtsRef['type'] | null;
  status: number;
  finalUrl: string | null;
  /** JD or page text, trimmed (resolver state). */
  text: string;
  /** The host refused us; nothing can be inferred from the page. */
  blocked: boolean;
}

export interface LadderTarget {
  url: string | null;
  hint?: AtsHint;
}

/**
 * Rungs 1 and 2: ATS public API, then page fetch. Never decides "closed" from soft signals;
 * the resolver rung (run.ts) always confirms a close before anything is archived.
 */
export async function assess(target: LadderTarget, ats: AtsClient, fetchFn: FetchLike, maxText = 6000): Promise<Evidence> {
  const { url } = target;
  if (!url) {
    return {
      method: 'page',
      verdict: 'inconclusive',
      reason: 'no url on file',
      ats: null,
      status: 0,
      finalUrl: null,
      text: '',
      blocked: false,
    };
  }
  const ref = detectAts(url, target.hint);
  let atsNote = '';
  if (ref) {
    const res = await ats.check(ref);
    if (res.state === 'open') {
      return {
        method: 'ats_api',
        verdict: 'open',
        reason: `${ref.type} api: posting live`,
        ats: ref.type,
        status: res.status,
        finalUrl: res.posting.url,
        text: res.posting.text.slice(0, maxText),
        blocked: false,
      };
    }
    if (res.state === 'closed') {
      return {
        method: 'ats_api',
        verdict: 'closed',
        reason: res.reason,
        ats: ref.type,
        status: res.status,
        finalUrl: null,
        text: '',
        blocked: false,
      };
    }
    atsNote = `${res.reason}; `;
  }
  const page = await checkPage(url, fetchFn, maxText);
  return {
    method: 'page',
    verdict: page.signal,
    reason: `${atsNote}${page.reason}`,
    ats: ref?.type ?? null,
    status: page.status,
    finalUrl: page.finalUrl,
    text: page.text,
    blocked: page.blocked,
  };
}
