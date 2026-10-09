import type { BoardCache, FetchLike, ListedPosting } from '../integrations/ats/index.js';
import { normalizeUrl } from '../ops/dedupe.js';
import { type CompanyHint, findBoard } from './boards.js';
import { type ScanRules, type ScreenReason, screen } from './filter.js';
import { cutCompany, type FitScorer, interleave } from './rank.js';

/*
 * Watchlist scan (#28): every open posting on each watchlist company's ATS board, through the rule
 * filter, minus postings already in the pipeline. Companies without a board we can read come back
 * `no_board` so the skill falls back to web search (under the watchlist query share).
 * #67: each company's survivors are ranked by fit, near-identical titles grouped, and at most
 * `maxPerCompany` returned; candidates come back best first, companies interleaved.
 */

export interface ScanCompany extends CompanyHint {
  name: string;
}

export interface ScanCandidate {
  company_name: string;
  title: string;
  url: string;
  ats_job_id: string;
  source: 'watchlist';
  posted_at?: string;
  workplace?: 'remote' | 'hybrid' | 'onsite';
  location?: string;
  comp_min?: number;
  comp_max?: number;
  comp_currency?: string;
  jd_markdown?: string;
}

export interface ScanCompanyResult {
  company: string;
  name: string;
  state: 'scanned' | 'no_board' | 'error';
  ats: string | null;
  board: string | null;
  listed: number;
  kept: number;
  capped: number;
  grouped: number;
  reason?: string;
}

export interface ScanResult {
  companies: ScanCompanyResult[];
  candidates: ScanCandidate[];
  dropped: Record<ScreenReason | 'known' | 'similar' | 'company_cap', number>;
  groups: Array<{ company: string; kept: string; title: string; similar: string[] }>;
  max_per_company: number;
}

export interface Known {
  urls: Set<string>;
  jobIds: Set<string>;
}

const isoOrUndefined = (s: string | null): string | undefined => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

function toCandidate(name: string, p: ListedPosting, jdChars: number): ScanCandidate {
  const w = p.workplace;
  const posted = isoOrUndefined(p.postedAt);
  const jd = jdChars > 0 ? p.text.trim().slice(0, jdChars) : '';
  return {
    company_name: name,
    title: p.title.trim(),
    url: p.url as string,
    ats_job_id: p.jobId,
    source: 'watchlist',
    ...(posted ? { posted_at: posted } : {}),
    ...(w === 'remote' || w === 'hybrid' || w === 'onsite' ? { workplace: w } : {}),
    ...(p.location ? { location: p.location } : {}),
    ...(p.comp ? { comp_min: p.comp.min, comp_max: p.comp.max, comp_currency: p.comp.currency } : {}),
    ...(jd ? { jd_markdown: jd.length < p.text.trim().length ? `${jd}...` : jd } : {}),
  };
}

export async function scanWatchlist(
  companies: readonly ScanCompany[],
  rules: ScanRules,
  known: Known,
  deps: { fetch: FetchLike; boards: BoardCache; jdChars: number; fit: FitScorer; maxPerCompany: number },
): Promise<ScanResult> {
  const out: ScanResult = {
    companies: [],
    candidates: [],
    dropped: { title: 0, seniority: 0, work_mode: 0, location: 0, known: 0, similar: 0, company_cap: 0 },
    groups: [],
    max_per_company: deps.maxPerCompany,
  };
  const perCompany: ScanCandidate[][] = [];
  for (const c of companies) {
    const search = await findBoard(c, deps.fetch, deps.boards);
    if (!search.found) {
      out.companies.push({
        company: c.slug,
        name: c.name,
        state: search.errors.length ? 'error' : 'no_board',
        ats: null,
        board: null,
        listed: 0,
        kept: 0,
        capped: 0,
        grouped: 0,
        ...(search.errors.length ? { reason: search.errors.join('; ') } : {}),
      });
      continue;
    }
    const { ref, postings } = search.found;
    const passed: ScanCandidate[] = [];
    for (const p of postings) {
      if (!p.url) continue;
      if (known.jobIds.has(p.jobId) || known.urls.has(normalizeUrl(p.url) ?? '')) {
        out.dropped.known++;
        continue;
      }
      const s = screen(p, rules);
      if (!s.keep) {
        out.dropped[s.reason]++;
        continue;
      }
      passed.push(toCandidate(c.name, p, deps.jdChars));
    }
    const cut = cutCompany(passed, deps.fit, deps.maxPerCompany);
    perCompany.push(cut.kept);
    out.dropped.similar += cut.grouped;
    out.dropped.company_cap += cut.capped;
    for (const g of cut.groups)
      out.groups.push({ company: c.slug, kept: g.kept.url, title: g.kept.title, similar: g.similar.map((x) => x.title) });
    out.companies.push({
      company: c.slug,
      name: c.name,
      state: 'scanned',
      ats: ref.type,
      board: ref.board,
      listed: postings.length,
      kept: cut.kept.length,
      capped: cut.capped,
      grouped: cut.grouped,
    });
  }
  out.candidates = interleave(perCompany);
  return out;
}
