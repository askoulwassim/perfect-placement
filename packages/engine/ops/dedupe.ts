import type { AtsType } from '@perfect-placement/contracts';

/*
 * Dedupe mechanics ported from v1 scout.py: url, ATS job id, company + title.
 * v2 makes the title match fuzzy (token Jaccard after abbreviation expansion).
 */

const TRACKING_PARAMS = /^(utm_.*|ref|referrer|source|src|gh_src|lever-source|lever-origin|trk|trackingid)$/i;

/** Normalize a posting url for comparison: lowercase host, drop hash, tracking params, trailing slash. */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const qs = keep.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    return `${host}${path}${qs ? `?${qs}` : ''}`;
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase();
  }
}

export interface AtsInfo {
  type: AtsType;
  board: string | null;
  jobId: string | null;
}

/** Infer ATS type, board and job id from a posting url (Greenhouse, Lever, Ashby, Workday). */
export function atsFromUrl(raw: string | null | undefined): AtsInfo {
  const none: AtsInfo = { type: 'unknown', board: null, jobId: null };
  if (!raw) return none;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return none;
  }
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  const ghJid = u.searchParams.get('gh_jid');
  if (host.endsWith('greenhouse.io')) {
    const jobs = seg.indexOf('jobs');
    const board = seg[0] && seg[0] !== 'embed' ? seg[0] : u.searchParams.get('for');
    const id = jobs >= 0 ? seg[jobs + 1] : (ghJid ?? u.searchParams.get('token'));
    return { type: 'greenhouse', board: board ?? null, jobId: id && /^\d+$/.test(id) ? id : null };
  }
  if (ghJid && /^\d+$/.test(ghJid)) return { type: 'greenhouse', board: null, jobId: ghJid };
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co')
    return { type: 'lever', board: seg[0] ?? null, jobId: seg[1] && /^[0-9a-f-]{36}$/i.test(seg[1]) ? seg[1].toLowerCase() : null };
  if (host === 'jobs.ashbyhq.com')
    return { type: 'ashby', board: seg[0] ?? null, jobId: seg[1] && /^[0-9a-f-]{36}$/i.test(seg[1]) ? seg[1].toLowerCase() : null };
  if (host.endsWith('myworkdayjobs.com')) {
    const last = seg[seg.length - 1] ?? '';
    const m = /_([A-Za-z]*-?\d+(?:-\d+)?)$/.exec(last);
    return { type: 'workday', board: host.split('.')[0] ?? null, jobId: m?.[1] ?? null };
  }
  return none;
}

const ABBREVIATIONS: Record<string, string> = {
  pm: 'product manager',
  gpm: 'group product manager',
  tpm: 'technical program manager',
  sr: 'senior',
  snr: 'senior',
  jr: 'junior',
  mgr: 'manager',
  mngr: 'manager',
  dir: 'director',
  vp: 'vice president',
  svp: 'senior vice president',
  eng: 'engineering',
  engr: 'engineer',
  ml: 'machine learning',
  genai: 'generative ai',
  gen: 'generative',
  mgmt: 'management',
  prod: 'product',
  fde: 'forward deployed engineer',
};
const STOPWORDS = new Set([
  'the',
  'of',
  'and',
  'a',
  'an',
  'for',
  'to',
  'in',
  'at',
  'with',
  'on',
  'remote',
  'hybrid',
  'onsite',
  'us',
  'usa',
]);

/** Title -> normalized token set. "Sr. PM, AI Platform (Remote)" -> {senior, product, manager, ai, platform}. */
export function titleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((w) => (ABBREVIATIONS[w] ?? w).split(' '));
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

/** Jaccard similarity of normalized title tokens, 0..1. */
export function titleSimilarity(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** At or above: same job. */
export const TITLE_DUPLICATE_MIN = 0.9;
/** At or above (and below the duplicate bar): ask the resolver `roles.dedupe`. */
export const TITLE_POSSIBLE_MIN = 0.6;
