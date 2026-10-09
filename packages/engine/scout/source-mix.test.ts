import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeFetch, recorded } from '../integrations/ats/__fixtures__/fake-fetch.js';
import { achievedMix, mixLine } from '../scoring/source-mix.js';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';
import { cutCompany, fitScorer, interleave, rankByFit } from './index.js';

/*
 * #67: a big watchlist board must not swamp a scout run. Board candidates are ranked, grouped and capped
 * per company; roles.add caps a run's watchlist adds at its share of the target; runs.finish reports the
 * achieved source mix.
 */

const PROFILE = {
  craft: { functions: ['PM', 'TPM'], level: 'principal' },
  domain: { ranked: ['data infrastructure', 'AI tooling', 'developer platforms', 'fintech'] },
};

describe('board ranking (pure)', () => {
  const fit = fitScorer(PROFILE);
  const c = (title: string, i: number) => ({ title, url: `https://x.test/${i}` });

  it('ranks on-level, on-domain titles first', () => {
    const ranked = rankByFit(
      ['Product Manager, Radar', 'Staff Product Manager, AI', 'Principal Product Manager, Data Platform', 'Senior PM, Treasury'].map(c),
      fit,
    ).map((x) => x.title);
    expect(ranked).toEqual([
      'Principal Product Manager, Data Platform',
      'Staff Product Manager, AI',
      'Senior PM, Treasury',
      'Product Manager, Radar',
    ]);
  });

  it('groups near-identical titles and keeps at most max per company', () => {
    const cut = cutCompany(
      ['Staff PM, Payments', 'Staff Product Manager - Payments', 'PM, Billing', 'PM, Identity', 'Principal PM, Data'].map(c),
      fit,
      2,
    );
    expect(cut.kept.map((x) => x.title)).toEqual(['Principal PM, Data', 'Staff PM, Payments']);
    expect(cut.groups).toEqual([{ kept: c('Staff PM, Payments', 0), similar: [c('Staff Product Manager - Payments', 1)] }]);
    expect(cut.grouped).toBe(1);
    expect(cut.capped).toBe(2);
  });

  it('interleaves companies so the first candidates spread across them', () => {
    expect(interleave([['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']])).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  });

  it('reports the achieved mix against the target', () => {
    const m = achievedMix(
      [
        ...Array.from({ length: 9 }, (_, i) => ({ source: 'watchlist', company_id: i < 5 ? 'bigco' : 'vercel' })),
        ...Array.from({ length: 16 }, () => ({ source: 'scout', company_id: 'x' })),
      ],
      { target_new_roles: 25, watchlist_share_max: 0.34 },
    );
    expect(m).toMatchObject({ added: 25, watchlist: 9, open: 16, watchlist_max: 9, watchlist_share: 0.36 });
    expect(mixLine(m)).toBe(
      'Source mix: 25 added of 25 target; watchlist 9 (36%, target at most 9 / 34%) [bigco 5, vercel 4], open market 16',
    );
  });
});

// A synthetic board built from the recorded Greenhouse list shape (vercel), one big company.
const GH = (board: string) => `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
const BIG_TITLES = [
  'Staff Product Manager, Payments',
  'Staff Product Manager, Payments',
  'Product Manager, Billing',
  'Principal Product Manager, Data Platform',
  'Senior Product Manager, Treasury',
  'Technical Program Manager, Infrastructure',
  'Product Manager, Identity',
  'Product Manager, Radar',
  'Staff Product Manager, AI',
];
function bigBoard(): string {
  const base = (JSON.parse(recorded('greenhouse_list_200.json')) as { jobs: Record<string, unknown>[]; meta: unknown }).jobs[0];
  const jobs = BIG_TITLES.map((title, i) => ({
    ...base,
    id: 7000000000 + i,
    internal_job_id: 8000000000 + i,
    title,
    company_name: 'Bigco',
    absolute_url: `https://job-boards.greenhouse.io/bigco/jobs/${7000000000 + i}`,
    content: `&lt;p&gt;${title} at Bigco. Synthetic.&lt;/p&gt;`,
  }));
  return JSON.stringify({ jobs, meta: { total: jobs.length } });
}
function boards(url: string) {
  if (url === GH('bigco')) return { status: 200, body: bigBoard() };
  if (url === GH('vercel')) return { status: 200, body: recorded('greenhouse_list_200.json') };
  if (
    url.startsWith('https://boards-api.greenhouse.io/') ||
    url.startsWith('https://api.lever.co/') ||
    url.startsWith('https://api.ashbyhq.com/')
  )
    return { status: 404, body: '{}' };
  return undefined;
}

describe('scout.watchlist_scan on a big board (#67)', () => {
  let e: FixtureEngine;
  afterEach(() => e.cleanup());

  it('returns at most max_per_company per company, best first, near-identical titles grouped', async () => {
    e = openFixtureEngine({ services: { fetch: fakeFetch(boards) } });
    const out = okOut(await e.runOp('scout.watchlist_scan', { companies: ['bigco', 'vercel'], jd_chars: 0 }, ctxAt()));
    expect(out.max_per_company).toBe(5);
    expect(out.companies[0]).toMatchObject({ company: 'bigco', listed: 9, kept: 5, grouped: 1, capped: 3 });
    expect(out.dropped).toMatchObject({ similar: 1, company_cap: 3 });
    expect(out.groups).toEqual([
      {
        company: 'bigco',
        kept: 'https://job-boards.greenhouse.io/bigco/jobs/7000000000',
        title: 'Staff Product Manager, Payments',
        similar: ['Staff Product Manager, Payments'],
      },
    ]);
    // Companies interleaved: bigco's best, then vercel's only one, then the rest of bigco.
    expect(out.candidates.map((c: { company_name: string; title: string }) => `${c.company_name}: ${c.title}`)).toEqual([
      'Bigco: Principal Product Manager, Data Platform',
      'Vercel: Product Manager, Dashboard',
      'Bigco: Staff Product Manager, AI',
      'Bigco: Staff Product Manager, Payments',
      'Bigco: Technical Program Manager, Infrastructure',
      'Bigco: Senior Product Manager, Treasury',
    ]);

    const two = okOut(await e.runOp('scout.watchlist_scan', { companies: ['bigco'], max_per_company: 2 }, ctxAt()));
    expect(two.candidates).toHaveLength(2);
    expect(two.companies[0]).toMatchObject({ kept: 2, capped: 6, grouped: 1 });
  });
});

describe('roles.add watchlist budget per scout run (#67)', () => {
  let e: FixtureEngine;
  afterEach(() => e.cleanup());

  const WORDS = ['Payments', 'Billing', 'Identity', 'Radar', 'Treasury', 'Issuing', 'Terminal', 'Atlas', 'Climate', 'Capital'];
  const CO = ['Alphaco', 'Betaco', 'Gammaco', 'Deltaco'];
  const wl = (company: string, i: number) => ({
    company_name: company,
    title: `Staff Product Manager, ${WORDS[i]}`,
    url: `https://job-boards.greenhouse.io/${company.toLowerCase()}/jobs/${9100000 + CO.indexOf(company) * 100 + i}`,
    source: 'watchlist' as const,
  });

  it('stops watchlist adds at ceil(share x target) and max_per_company; open-market adds still go in', async () => {
    e = openFixtureEngine();
    const { run } = okOut(await e.runOp('runs.start', { skill: 'scout' }, ctxAt()));
    const ctx = ctxAt('agent', { runId: run.id });
    const candidates = [
      ...Array.from({ length: 7 }, (_, i) => wl('Alphaco', i)),
      ...Array.from({ length: 3 }, (_, i) => wl('Betaco', i)),
      ...Array.from({ length: 2 }, (_, i) => wl('Gammaco', i)),
      { company_name: 'Openco', title: 'Principal PM, Data', source: 'scout' as const },
      { company_name: 'Openco', title: 'Group TPM, Infra', source: 'scout' as const },
    ];
    const out = okOut(await e.runOp('roles.add', { candidates, verify: false }, ctx));
    // target 25 x share 0.34 -> 9 watchlist adds; max 5 per company (company_active_cap 3 + 2).
    expect(out.added).toHaveLength(11);
    expect(out.skipped.map((s: { index: number; reason: string }) => [s.index, s.reason])).toEqual([
      [5, 'company_cap'],
      [6, 'company_cap'],
      [11, 'watchlist_cap'],
    ]);
    expect(out.by_source.watchlist).toEqual({
      candidates: 12,
      added: 9,
      duplicates: 0,
      skipped_dead: 0,
      skipped_aggregator: 0,
      skipped_cap: 3,
    });
    expect(out.watchlist_budget).toEqual({
      run_id: run.id,
      target: 25,
      max: 9,
      added: 9,
      remaining: 0,
      max_per_company: 5,
      open_added: 2,
      open_needed: 14,
    });

    // Later calls in the same run: no more watchlist roles, however they are batched.
    const again = okOut(await e.runOp('roles.add', { candidates: [wl('Deltaco', 0)], verify: false }, ctx));
    expect(again.added).toEqual([]);
    expect(again.skipped[0]).toMatchObject({ reason: 'watchlist_cap' });

    const fin = okOut(await e.runOp('runs.finish', { run_id: run.id, status: 'ok' }, ctx));
    expect(fin.run.summary_json.source_mix).toMatchObject({ target: 25, added: 11, watchlist: 9, open: 2, watchlist_max: 9 });
    expect(fin.run.summary_json.source_mix.by_company).toEqual({ alphaco: 5, betaco: 3, gammaco: 1 });
    const log = readFileSync(join(e.home, fin.run.log_path), 'utf8');
    expect(log).toContain('Source mix: 11 added of 25 target; watchlist 9 (82%, target at most 9 / 34%)');
    expect(log).toContain('Watchlist this run: 9 of 9');
  });

  it('outside a scout run the limits apply per call', async () => {
    e = openFixtureEngine();
    const out = okOut(
      await e.runOp('roles.add', { candidates: Array.from({ length: 7 }, (_, i) => wl('Alphaco', i)), verify: false }, ctxAt()),
    );
    expect(out.added).toHaveLength(5);
    expect(out.watchlist_budget).toMatchObject({ run_id: null, added: 5 });
  });
});
