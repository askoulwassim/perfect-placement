import { type FetchLike, htmlToText, pageTitle } from '../integrations/ats/index.js';

/**
 * Page fallback (rung 2 of the ladder). Proves closure only from hard signals; everything else
 * is `inconclusive` and goes to the resolver with the page text as state.
 */
export type PageSignal = 'closed' | 'inconclusive';

export interface PageCheck {
  signal: PageSignal;
  reason: string;
  status: number;
  finalUrl: string;
  title: string | null;
  /** Visible text, trimmed to `maxText` chars (resolver state). */
  text: string;
  /** True when the host refused us (bot wall, rate limit): nothing can be inferred. */
  blocked: boolean;
}

/** Phrases that mean the posting is gone. Lowercase; matched against visible text. */
export const CLOSED_PHRASES = [
  'no longer accepting applications',
  'no longer accepting candidates',
  'this job is no longer available',
  'this job is no longer open',
  'job is no longer available',
  'this position is no longer available',
  'this position has been filled',
  'this role has been filled',
  'this position has been closed',
  'this job has been closed',
  'this job posting has expired',
  'this posting has expired',
  'this posting is closed',
  'the job you are looking for is no longer',
  "the job you're looking for is no longer",
  'the position you are looking for is no longer',
  'job not found',
  'posting not found',
  'applications are closed',
  'applications for this role have closed',
] as const;

/** Statuses that mean we were refused, not that the job is gone. 999 = LinkedIn bot wall. */
const BLOCKED = new Set([401, 403, 429, 999]);

const ID_SEGMENT = /^(\d{5,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Redirected away from the posting to a listing / error page. */
export function isListingRedirect(original: string, final: string): boolean {
  if (!final || final === original) return false;
  let a: URL;
  let b: URL;
  try {
    a = new URL(original);
    b = new URL(final);
  } catch {
    return false;
  }
  if (b.searchParams.get('error') === 'true') return true; // Greenhouse: /{board}?error=true
  const ids = a.pathname.split('/').filter((s) => ID_SEGMENT.test(s));
  const ghJid = a.searchParams.get('gh_jid');
  if (ghJid) ids.push(ghJid);
  if (ids.length === 0) return false;
  return !ids.some((id) => b.pathname.includes(id) || b.search.includes(id));
}

export function closedPhrase(text: string): string | null {
  const t = text.toLowerCase().replace(/\s+/g, ' ').replace(/[’]/g, "'");
  return CLOSED_PHRASES.find((p) => t.includes(p)) ?? null;
}

/** Ashby job pages are an SPA shell; `"posting":null` in the boot data means no such posting. */
function ashbyMissingPosting(html: string): boolean {
  return /window\.__appData\s*=/.test(html) && /"posting"\s*:\s*null/.test(html);
}

export async function checkPage(url: string, fetchFn: FetchLike, maxText = 6000): Promise<PageCheck> {
  let status = 0;
  let finalUrl = url;
  let html = '';
  try {
    const res = await fetchFn(url, { redirect: 'follow', headers: { accept: 'text/html,*/*;q=0.8' } });
    status = res.status;
    finalUrl = res.url || url;
    html = await res.text().catch(() => '');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { signal: 'inconclusive', reason: `fetch failed: ${msg}`, status: 0, finalUrl, title: null, text: '', blocked: true };
  }
  const text = htmlToText(html);
  const base = { status, finalUrl, title: pageTitle(html), text: text.slice(0, maxText) };
  if (BLOCKED.has(status)) return { ...base, signal: 'inconclusive', reason: `blocked (status ${status})`, blocked: true };
  if (status === 404 || status === 410) return { ...base, signal: 'closed', reason: `page status ${status}`, blocked: false };
  if (status >= 500) return { ...base, signal: 'inconclusive', reason: `page status ${status}`, blocked: true };
  if (isListingRedirect(url, finalUrl)) return { ...base, signal: 'closed', reason: `redirected to listing (${finalUrl})`, blocked: false };
  if (ashbyMissingPosting(html)) return { ...base, signal: 'closed', reason: 'ashby page: posting null', blocked: false };
  const phrase = closedPhrase(text);
  if (phrase) return { ...base, signal: 'closed', reason: `closed phrase: "${phrase}"`, blocked: false };
  return { ...base, signal: 'inconclusive', reason: 'no closed signal', blocked: false };
}
