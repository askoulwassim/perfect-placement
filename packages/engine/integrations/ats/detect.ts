import type { AtsType } from '@perfect-placement/contracts';

/** A posting located on a supported ATS. `region` selects the EU API host when the board lives there. */
export type AtsRef =
  | { type: 'greenhouse'; board: string; jobId: string; region: 'us' | 'eu' }
  | { type: 'lever'; company: string; postingId: string; region: 'us' | 'eu' }
  | { type: 'ashby'; board: string; jobId: string };

/** What the db already knows about the company (`company.ats_type`, `company.ats_board`). */
export interface AtsHint {
  ats_type?: AtsType | null;
  ats_board?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGITS = /^\d{4,}$/;

/** `host` is `domain` or a subdomain of it. A bare `endsWith` would also take `evilgreenhouse.io` (#152). */
export const onDomain = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`);

/**
 * Detect the ATS and posting id from a role URL. Pure. Returns null when the URL is not a
 * recognisable ATS posting (custom career pages, LinkedIn, aggregators): those go to the page fallback.
 * A company-site URL carrying `gh_jid` resolves when the company hint names its Greenhouse board.
 */
export function detectAts(url: string | null | undefined, hint?: AtsHint): AtsRef | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);

  // Greenhouse: boards.greenhouse.io/{board}/jobs/{id}, job-boards(.eu).greenhouse.io/{board}/jobs/{id},
  // boards.greenhouse.io/embed/job_app?for={board}&token={id}
  if (onDomain(host, 'greenhouse.io')) {
    const region = host.includes('.eu.') ? 'eu' : 'us';
    if (parts[0] === 'embed') {
      const board = u.searchParams.get('for');
      const jobId = u.searchParams.get('token') ?? u.searchParams.get('gh_jid');
      return board && jobId && DIGITS.test(jobId) ? { type: 'greenhouse', board, jobId, region } : null;
    }
    const jobsAt = parts.indexOf('jobs');
    const board = parts[0];
    const jobId = jobsAt > 0 ? parts[jobsAt + 1] : (u.searchParams.get('gh_jid') ?? undefined);
    if (board && jobId && DIGITS.test(jobId)) return { type: 'greenhouse', board, jobId, region };
    return null;
  }

  // Lever: jobs.lever.co/{company}/{uuid}[/apply], jobs.eu.lever.co/...
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    const [company, postingId] = parts;
    if (company && postingId && UUID.test(postingId)) {
      return { type: 'lever', company, postingId: postingId.toLowerCase(), region: host.includes('.eu.') ? 'eu' : 'us' };
    }
    return null;
  }

  // Ashby: jobs.ashbyhq.com/{board}/{uuid}[/application]
  if (host === 'jobs.ashbyhq.com') {
    const [board, jobId] = parts;
    if (board && jobId && UUID.test(jobId)) return { type: 'ashby', board, jobId: jobId.toLowerCase() };
    return null;
  }

  // Company career site embedding Greenhouse (`?gh_jid=`), or Ashby (`?ashby_jid=`).
  const ghJid = u.searchParams.get('gh_jid');
  if (ghJid && DIGITS.test(ghJid) && hint?.ats_type === 'greenhouse' && hint.ats_board) {
    return { type: 'greenhouse', board: hint.ats_board, jobId: ghJid, region: 'us' };
  }
  const ashbyJid = u.searchParams.get('ashby_jid');
  if (ashbyJid && UUID.test(ashbyJid) && hint?.ats_type === 'ashby' && hint.ats_board) {
    return { type: 'ashby', board: hint.ats_board, jobId: ashbyJid.toLowerCase() };
  }
  return null;
}

/** The `company.ats_type` value a URL implies (for intake). */
export function atsTypeOf(url: string | null | undefined): AtsType {
  const ref = detectAts(url);
  if (ref) return ref.type;
  if (url && /myworkdayjobs\.com|workday\.com/i.test(url)) return 'workday';
  return url ? 'other' : 'unknown';
}
