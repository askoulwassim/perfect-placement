import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeFetch, page, recorded } from '../integrations/ats/__fixtures__/fake-fetch.js';
import { boardListUrl, listBoard } from '../integrations/ats/index.js';
import { ctxAt, type FixtureEngine, okOut, openFixtureEngine } from '../testing/index.js';
import { aggregatorOf, boardCandidates, levelOf, rulesFromProfile, screen } from './index.js';

/*
 * Recorded 2026-10-09 from the public list APIs: Greenhouse (vercel), Lever (leverdemo), Ashby (linear);
 * trimmed to a few postings, descriptions replaced with synthetic text.
 */
const GH_LIST = 'https://boards-api.greenhouse.io/v1/boards/vercel/jobs?content=true';
const LV_LIST = 'https://api.lever.co/v0/postings/leverdemo?mode=json';
const AB_LIST = 'https://api.ashbyhq.com/posting-api/job-board/linear?includeCompensation=true';
const GH_404 = { status: 404, body: recorded('greenhouse_list_404.json') };
const LV_404 = { status: 404, body: recorded('lever_posting_404.json') };
const AB_404 = { status: 404, body: recorded('ashby_board_404.txt') };

/** Live boards: vercel (Greenhouse), linear (Ashby), leverdemo (Lever). Every other board is missing. */
function boards(url: string) {
  if (url === GH_LIST) return { status: 200, body: recorded('greenhouse_list_200.json') };
  if (url === LV_LIST) return { status: 200, body: recorded('lever_list_200.json') };
  if (url === AB_LIST) return { status: 200, body: recorded('ashby_list_200.json') };
  if (url.startsWith('https://boards-api.greenhouse.io/v1/boards/') && url.endsWith('/jobs?content=true')) return GH_404;
  if (url.startsWith('https://api.lever.co/v0/postings/') && url.endsWith('?mode=json')) return LV_404;
  if (url.startsWith('https://api.ashbyhq.com/posting-api/job-board/')) return AB_404;
  return undefined;
}

const FIXTURE_PROFILE = { craft: { functions: ['PM', 'TPM'], level: 'principal' }, work_mode: { modes: ['remote'], locations: ['US'] } };

describe('board listings', () => {
  it('lists Greenhouse, Lever and Ashby boards with JD, workplace and comp', async () => {
    const f = fakeFetch(boards);
    const gh = await listBoard({ type: 'greenhouse', board: 'vercel' }, f);
    if (gh.state !== 'ok') throw new Error(gh.state);
    expect(gh.postings).toHaveLength(7);
    expect(gh.postings[0]).toMatchObject({
      ats: 'greenhouse',
      jobId: '6205772004',
      title: 'Product Manager, Dashboard',
      url: 'https://job-boards.greenhouse.io/vercel/jobs/6205772004',
      location: 'Remote - United States',
      workplace: 'remote',
      comp: null,
    });
    expect(gh.postings[0]?.text).toContain('Synthetic shortened description');
    expect(gh.postings.find((p) => p.title === 'Product Manager, Compute')?.workplace).toBe('hybrid');

    const lv = await listBoard({ type: 'lever', board: 'leverdemo' }, f);
    if (lv.state !== 'ok') throw new Error(lv.state);
    expect(lv.postings[0]).toMatchObject({
      ats: 'lever',
      title: 'Customer Success Manager',
      workplace: 'hybrid',
      comp: { min: 85000, max: 175000, currency: 'USD' },
    });

    const ab = await listBoard({ type: 'ashby', board: 'linear' }, f);
    if (ab.state !== 'ok') throw new Error(ab.state);
    expect(ab.postings.map((p) => [p.title, p.workplace])).toContainEqual(['Product Manager', 'remote']);

    expect((await listBoard({ type: 'greenhouse', board: 'nope' }, f)).state).toBe('missing');
    expect((await listBoard({ type: 'ashby', board: 'nope' }, f)).state).toBe('missing');
    const down = await listBoard(
      { type: 'lever', board: 'x' },
      fakeFetch(() => ({ status: 503, body: '' })),
    );
    expect(down).toMatchObject({ state: 'error', status: 503 });
    expect(boardListUrl({ type: 'greenhouse', board: 'acme', region: 'eu' })).toBe(
      'https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs?content=true',
    );
  });

  it('probes the known board first, then the slug on every supported ATS; never probes Workday companies', () => {
    expect(boardCandidates({ slug: 'acme-robotics', ats_type: 'lever', ats_board: 'acme' }).map((r) => `${r.type}:${r.board}`)).toEqual([
      'lever:acme',
      'greenhouse:acme',
      'greenhouse:acme-robotics',
      'greenhouse:acmerobotics',
      'lever:acme-robotics',
      'lever:acmerobotics',
      'ashby:acme',
      'ashby:acme-robotics',
      'ashby:acmerobotics',
    ]);
    expect(boardCandidates({ slug: 'snowflake', ats_type: 'workday', ats_board: null })).toEqual([]);
  });
});

describe('aggregators', () => {
  it('recognises aggregator hosts and leaves company and ATS pages alone', () => {
    expect(aggregatorOf('https://www.linkedin.com/jobs/view/123')).toBe('linkedin');
    expect(aggregatorOf('https://www.builtinboston.com/job/product-manager/1')).toBe('builtin');
    expect(aggregatorOf('https://builtin.com/job/x/1')).toBe('builtin');
    expect(aggregatorOf('https://uk.indeed.com/viewjob?jk=1')).toBe('indeed');
    expect(aggregatorOf('https://www.glassdoor.co.uk/job-listing/x')).toBe('glassdoor');
    expect(aggregatorOf('https://wellfound.com/jobs/1')).toBe('wellfound');
    expect(aggregatorOf('https://job-boards.greenhouse.io/vercel/jobs/1')).toBeNull();
    expect(aggregatorOf('https://stripe.com/jobs/listing/x/1')).toBeNull();
    expect(aggregatorOf('not a url')).toBeNull();
  });
});

describe('rule filter', () => {
  const rules = rulesFromProfile(FIXTURE_PROFILE);
  const keep = (title: string, location: string | null = null, workplace: string | null = null) =>
    screen({ title, location, workplace }, rules);

  it('keeps on-function titles and drops other job families', () => {
    expect(keep('Senior Product Manager, Data')).toEqual({ keep: true });
    expect(keep('Group PM, Platform')).toEqual({ keep: true });
    expect(keep('Technical Program Manager')).toEqual({ keep: true });
    expect(keep('Product Designer')).toEqual({ keep: false, reason: 'title' });
    expect(keep('Product Marketing Manager')).toEqual({ keep: false, reason: 'title' });
    expect(keep('Software Engineer - Data Platform')).toEqual({ keep: false, reason: 'title' });
    expect(keep('Account Executive')).toEqual({ keep: false, reason: 'title' });
  });

  it('drops titles more than two levels below the profile level; unlevelled titles stay', () => {
    expect(levelOf('Sr. PM')).toBe(3);
    expect(levelOf('VP Product')).toBe(7);
    expect(keep('Associate Product Manager')).toEqual({ keep: false, reason: 'seniority' });
    expect(keep('Senior Product Manager')).toEqual({ keep: true }); // principal profile: senior is the lowest kept level
  });

  it('applies remote-only and US-only rules', () => {
    expect(keep('Product Manager', 'Hybrid - San Francisco', 'hybrid')).toEqual({ keep: false, reason: 'work_mode' });
    expect(keep('Product Manager', 'Europe', 'remote')).toEqual({ keep: false, reason: 'location' });
    expect(keep('Product Manager', 'Remote - United States', 'remote')).toEqual({ keep: true });
    expect(keep('Product Manager', 'New York', null)).toEqual({ keep: true });
  });

  it('include replaces the Craft phrases; exclude drops words', () => {
    const r = rulesFromProfile(FIXTURE_PROFILE, { include: ['Product Designer'], exclude: ['marketplace'] });
    expect(screen({ title: 'Senior Product Designer', location: null, workplace: null }, r)).toEqual({ keep: true });
    expect(screen({ title: 'Product Designer, Marketplace', location: null, workplace: null }, r)).toEqual({
      keep: false,
      reason: 'title',
    });
  });
});

describe('scout.watchlist_scan', () => {
  let e: FixtureEngine;
  afterEach(() => e.cleanup());

  it('scans each company board, filters by the profile and reports companies without a board', async () => {
    const f = fakeFetch(boards);
    e = openFixtureEngine({ services: { fetch: f } });
    const out = okOut(await e.runOp('scout.watchlist_scan', { companies: ['vercel', 'linear', 'Lever Demo', 'nohire'] }, ctxAt()));
    expect(out.companies).toEqual([
      { company: 'vercel', name: 'Vercel', state: 'scanned', ats: 'greenhouse', board: 'vercel', listed: 7, kept: 1 },
      { company: 'linear', name: 'Linear', state: 'scanned', ats: 'ashby', board: 'linear', listed: 5, kept: 1 },
      { company: 'lever-demo', name: 'Lever Demo', state: 'scanned', ats: 'lever', board: 'leverdemo', listed: 4, kept: 0 },
      { company: 'nohire', name: 'Nohire', state: 'no_board', ats: null, board: null, listed: 0, kept: 0 },
    ]);
    expect(out.candidates.map((c: { company_name: string; title: string }) => `${c.company_name}: ${c.title}`)).toEqual([
      'Vercel: Product Manager, Dashboard',
      'Linear: Product Manager',
    ]);
    expect(out.candidates[0]).toMatchObject({
      url: 'https://job-boards.greenhouse.io/vercel/jobs/6205772004',
      ats_job_id: '6205772004',
      source: 'watchlist',
      workplace: 'remote',
      location: 'Remote - United States',
    });
    expect(out.candidates[0].jd_markdown).toContain('Synthetic');
    expect(out.dropped).toEqual({ title: 12, seniority: 0, work_mode: 1, location: 1, known: 0 });
    // Nothing written: a read.
    expect(e.db.prepare(`SELECT count(*) n FROM company WHERE id IN ('lever-demo', 'nohire')`).get()).toEqual({ n: 0 });
  });

  it('defaults to the profile watchlist and skips postings already in the pipeline', async () => {
    e = openFixtureEngine({ services: { fetch: fakeFetch(boards) } });
    okOut(
      await e.runOp(
        'roles.add',
        {
          candidates: [
            {
              company_name: 'Linear',
              title: 'Product Manager',
              url: 'https://jobs.ashbyhq.com/linear/b7669c4b-eeca-421d-ba9a-d90203f6fcb2',
              source: 'watchlist',
            },
          ],
          verify: false,
        },
        ctxAt(),
      ),
    );
    const out = okOut(await e.runOp('scout.watchlist_scan', { jd_chars: 0 }, ctxAt()));
    // Fixture watchlist: linear, figma, stripe (figma and stripe have no recorded board).
    expect(out.companies.map((c: { company: string; state: string }) => `${c.company}:${c.state}`)).toEqual([
      'linear:scanned',
      'figma:no_board',
      'stripe:no_board',
    ]);
    expect(out.candidates).toEqual([]);
    expect(out.dropped.known).toBe(1);
  });
});

describe('roles.add intake check (#32)', () => {
  let e: FixtureEngine;
  afterEach(() => e.cleanup());

  const GH_JOB = 'https://boards-api.greenhouse.io/v1/boards/vercel/jobs/';
  const route = (url: string) => {
    if (url === `${GH_JOB}6136160004`) return { status: 200, body: recorded('greenhouse_job_200.json') };
    if (url === `${GH_JOB}6100000001`) return { status: 404, body: recorded('greenhouse_job_404.json') };
    if (url === 'https://api.lever.co/v0/postings/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b')
      return { status: 200, body: recorded('lever_posting_200.json') };
    if (url === 'https://careers.example.org/jobs/gone') return { status: 404, body: page('Not here') };
    if (url === 'https://careers.example.org/jobs/walled') return { status: 403, body: page('Access denied') };
    if (url === 'https://careers.example.org/jobs/12345678')
      return { status: 200, body: page('All jobs'), finalUrl: 'https://careers.example.org/jobs' };
    if (url === 'https://careers.example.org/jobs/filled') return { status: 200, body: page('<p>This position has been filled.</p>') };
    if (url === 'https://careers.example.org/jobs/live') return { status: 200, body: page('<h1>Data PM</h1><p>Apply now.</p>') };
    return boards(url);
  };

  it('skips dead postings, resolves aggregator links to the ATS posting, keeps bot walls as unsure', async () => {
    e = openFixtureEngine({ services: { fetch: fakeFetch(route) } });
    const li = (n: number) => `https://www.linkedin.com/jobs/view/${n}`;
    const out = okOut(
      await e.runOp(
        'roles.add',
        {
          candidates: [
            /* 0 */ {
              company_name: 'Vercel',
              title: 'Account Executive, Commercial',
              url: 'https://job-boards.greenhouse.io/vercel/jobs/6136160004',
              source: 'scout',
            },
            /* 1 */ {
              company_name: 'Vercel',
              title: 'Product Lead, Edge',
              url: 'https://job-boards.greenhouse.io/vercel/jobs/6100000001',
              source: 'scout',
            },
            /* 2 */ {
              company_name: 'Lever Demo',
              title: 'Customer Success Manager',
              url: 'https://jobs.lever.co/leverdemo/ad208490-4052-4f91-a57e-433f2d1e484b',
              source: 'watchlist',
            },
            /* 3 */ {
              company_name: 'Vercel',
              title: 'Product Manager - Dashboard',
              url: li(1),
              source: 'scout',
              jd_markdown: 'short summary',
            },
            /* 4 */ { company_name: 'Vercel', title: 'Product Manager, Dashboard (Remote)', url: li(2), source: 'scout' },
            /* 5 */ {
              company_name: 'Nohire',
              title: 'Principal PM',
              url: 'https://www.builtinboston.com/job/principal-pm/9',
              source: 'scout',
            },
            /* 6 */ { company_name: 'Vercel', title: 'Chief Vibes Officer', url: li(3), source: 'scout' },
            /* 7 */ { company_name: 'Example Org', title: 'PM A', url: 'https://careers.example.org/jobs/gone', source: 'scout' },
            /* 8 */ { company_name: 'Example Org', title: 'PM B', url: 'https://careers.example.org/jobs/walled', source: 'scout' },
            /* 9 */ { company_name: 'Example Org', title: 'PM C', url: 'https://careers.example.org/jobs/12345678', source: 'scout' },
            /* 10 */ { company_name: 'Example Org', title: 'PM D', url: 'https://careers.example.org/jobs/filled', source: 'scout' },
            /* 11 */ { company_name: 'Example Org', title: 'Data PM', url: 'https://careers.example.org/jobs/live', source: 'link' },
            /* 12 */ { company_name: 'Example Org', title: 'Referral PM', source: 'referral' },
          ],
        },
        ctxAt(),
      ),
    );
    expect(out.added).toEqual([
      'vercel_account-executive-commercial',
      'lever-demo_customer-success-manager',
      'vercel_product-manager-dashboard',
      'example-org_pm-b',
      'example-org_data-pm',
      'example-org_referral-pm',
    ]);
    expect(out.skipped.map((s: { index: number; reason: string }) => [s.index, s.reason])).toEqual([
      [1, 'dead'],
      [5, 'aggregator'],
      [6, 'aggregator'],
      [7, 'dead'],
      [9, 'dead'],
      [10, 'dead'],
    ]);
    expect(out.duplicates).toEqual([{ index: 4, existing_id: 'vercel_product-manager-dashboard', match: 'company_title' }]);
    expect(out.resolved).toEqual([
      { index: 3, role_id: 'vercel_product-manager-dashboard', from: li(1), to: 'https://job-boards.greenhouse.io/vercel/jobs/6205772004' },
    ]);
    expect(out.by_source).toEqual({
      scout: { candidates: 10, added: 3, duplicates: 1, skipped_dead: 4, skipped_aggregator: 2 },
      watchlist: { candidates: 1, added: 1, duplicates: 0, skipped_dead: 0, skipped_aggregator: 0 },
      link: { candidates: 1, added: 1, duplicates: 0, skipped_dead: 0, skipped_aggregator: 0 },
      referral: { candidates: 1, added: 1, duplicates: 0, skipped_dead: 0, skipped_aggregator: 0 },
    });

    const role = (id: string) => e.db.prepare('SELECT * FROM role WHERE id = ?').get(id) as Record<string, unknown>;
    expect(role('vercel_product-manager-dashboard')).toMatchObject({
      url: 'https://job-boards.greenhouse.io/vercel/jobs/6205772004',
      ats_job_id: '6205772004',
      freshness: 'open',
      workplace: 'remote',
      location: 'Remote - United States',
    });
    expect(role('vercel_account-executive-commercial')).toMatchObject({ freshness: 'open', ats_job_id: '6136160004' });
    expect(role('lever-demo_customer-success-manager')).toMatchObject({ freshness: 'open', location: 'Atlanta, Georgia' });
    expect(role('example-org_pm-b')).toMatchObject({ freshness: 'unsure' });
    expect(role('example-org_data-pm')).toMatchObject({ freshness: 'unknown', last_checked_at: null });
    expect(role('example-org_referral-pm')).toMatchObject({ freshness: 'unknown', url: null });
    // The company is created from the resolved ATS URL; the ATS JD replaces the agent's summary.
    const md = readFileSync(join(e.home, 'roles/vercel_product-manager-dashboard.md'), 'utf8');
    expect(md).toContain('Product Manager, Dashboard at Vercel. Synthetic shortened description.');
    expect(md).not.toContain('short summary');
    expect(md).toContain(`Resolved from ${li(1)}`);
    const run = e.db.prepare(`SELECT * FROM run WHERE op = 'roles.add'`).get() as { log_path: string; summary_json: string };
    expect(JSON.parse(run.summary_json)).toMatchObject({ skipped_dead: 4, skipped_aggregator: 2, resolved: 1 });
    expect(readFileSync(join(e.home, run.log_path), 'utf8')).toContain('| scout | 10 | 3 | 1 | 4 | 2 |');
  });

  it('makes no network call for a known role and none with verify: false', async () => {
    const f = fakeFetch(route);
    e = openFixtureEngine({ services: { fetch: f } });
    const existing = e.db.prepare(`SELECT url FROM role WHERE url IS NOT NULL LIMIT 1`).get() as { url: string };
    okOut(await e.runOp('roles.add', { candidates: [{ company_name: 'X', title: 'Y', url: existing.url, source: 'scout' }] }, ctxAt()));
    okOut(
      await e.runOp(
        'roles.add',
        { candidates: [{ company_name: 'X', title: 'Z', url: 'https://careers.example.org/jobs/gone', source: 'scout' }], verify: false },
        ctxAt(),
      ),
    );
    expect(f.calls).toEqual([]);
  });
});
