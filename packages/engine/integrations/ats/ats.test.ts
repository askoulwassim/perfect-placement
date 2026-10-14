import { describe, expect, it } from 'vitest';
import { fakeFetch, page, recorded } from './__fixtures__/fake-fetch.js';
import { ashbyBoardUrl, atsTypeOf, captureJd, createAtsClient, detectAts, greenhouseJobUrl, htmlToText, leverPostingUrl } from './index.js';

const GH_JOB = '6136160004';
const LV_ID = 'ad208490-4052-4f91-a57e-433f2d1e484b';
const AB_ID = 'd3bc1ced-3ce4-4086-a050-555055dbb1ff';

describe('detectAts', () => {
  it.each([
    ['https://job-boards.greenhouse.io/vercel/jobs/6136160004', { type: 'greenhouse', board: 'vercel', jobId: '6136160004', region: 'us' }],
    ['https://boards.greenhouse.io/stripe/jobs/7000012?gh_src=x', { type: 'greenhouse', board: 'stripe', jobId: '7000012', region: 'us' }],
    ['https://job-boards.eu.greenhouse.io/acme/jobs/4455667', { type: 'greenhouse', board: 'acme', jobId: '4455667', region: 'eu' }],
    [
      'https://boards.greenhouse.io/embed/job_app?for=figma&token=5551234',
      { type: 'greenhouse', board: 'figma', jobId: '5551234', region: 'us' },
    ],
    [`https://jobs.lever.co/leverdemo/${LV_ID}/apply`, { type: 'lever', company: 'leverdemo', postingId: LV_ID, region: 'us' }],
    [`https://jobs.eu.lever.co/acme/${LV_ID}`, { type: 'lever', company: 'acme', postingId: LV_ID, region: 'eu' }],
    [`https://jobs.ashbyhq.com/linear/${AB_ID.toUpperCase()}/application`, { type: 'ashby', board: 'linear', jobId: AB_ID }],
  ])('%s', (url, ref) => {
    expect(detectAts(url)).toEqual(ref);
  });

  it('returns null for non-ATS or malformed URLs', () => {
    expect(detectAts('https://www.linkedin.com/jobs/view/1234567890')).toBeNull();
    expect(detectAts('https://jobs.lever.co/retool/principal-pm-workflows-9')).toBeNull();
    expect(detectAts('https://jobs.ashbyhq.com/linear')).toBeNull();
    expect(detectAts('not a url')).toBeNull();
    expect(detectAts(null)).toBeNull();
  });

  it('takes greenhouse.io and its subdomains only, not a host that merely ends in it (#152)', () => {
    expect(detectAts('https://evilgreenhouse.io/acme/jobs/7000012')).toBeNull();
    expect(detectAts('https://boards.greenhouse.io.example.com/acme/jobs/7000012')).toBeNull();
    expect(detectAts('https://greenhouse.io/acme/jobs/7000012')).toMatchObject({ type: 'greenhouse', board: 'acme' });
  });

  it('uses the company hint for gh_jid / ashby_jid on company sites', () => {
    const url = 'https://stripe.com/jobs/listing/staff-pm/7000099?gh_jid=7000099';
    expect(detectAts(url)).toBeNull();
    expect(detectAts(url, { ats_type: 'greenhouse', ats_board: 'stripe' })).toEqual({
      type: 'greenhouse',
      board: 'stripe',
      jobId: '7000099',
      region: 'us',
    });
    expect(detectAts(`https://linear.app/careers?ashby_jid=${AB_ID}`, { ats_type: 'ashby', ats_board: 'linear' })).toEqual({
      type: 'ashby',
      board: 'linear',
      jobId: AB_ID,
    });
  });

  it('atsTypeOf maps to the company.ats_type enum', () => {
    expect(atsTypeOf(`https://jobs.ashbyhq.com/linear/${AB_ID}`)).toBe('ashby');
    expect(atsTypeOf('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/123')).toBe('workday');
    expect(atsTypeOf('https://careers.example.com/x')).toBe('other');
    expect(atsTypeOf(null)).toBe('unknown');
  });
});

describe('greenhouse (recorded)', () => {
  const ref = { type: 'greenhouse', board: 'vercel', jobId: GH_JOB, region: 'us' } as const;

  it('200 -> open with the full JD decoded', async () => {
    const f = fakeFetch((u) => (u === greenhouseJobUrl(ref) ? { status: 200, body: recorded('greenhouse_job_200.json') } : undefined));
    const res = await createAtsClient(f).check(ref);
    expect(res.state).toBe('open');
    if (res.state !== 'open') return;
    expect(res.posting.title).toBe('Account Executive, Commercial');
    expect(res.posting.location).toBe('Hybrid - London');
    expect(res.posting.html).toContain('<h2>About Vercel:</h2>');
    expect(res.posting.text).toContain('Own the account lifecycle & grow revenue.');
    expect(res.posting.postedAt).toBe('2026-08-06T12:50:10-04:00');
  });

  it('404 job not found -> closed', async () => {
    const f = fakeFetch(() => ({ status: 404, body: recorded('greenhouse_job_404.json') }));
    expect((await createAtsClient(f).check(ref)).state).toBe('closed');
  });

  it('404 board not found -> unknown (falls to page)', async () => {
    const f = fakeFetch(() => ({ status: 404, body: recorded('greenhouse_board_404.json') }));
    expect(await createAtsClient(f).check(ref)).toMatchObject({ state: 'unknown', reason: 'greenhouse board not found' });
  });

  it('bare 404 checks the board before calling it closed', async () => {
    const live = fakeFetch((u) =>
      u.endsWith('/jobs/6136160004') ? { status: 404, body: '' } : { status: 200, body: recorded('greenhouse_board_200.json') },
    );
    expect((await createAtsClient(live).check(ref)).state).toBe('closed');
    const dead = fakeFetch(() => ({ status: 404, body: '' }));
    expect((await createAtsClient(dead).check(ref)).state).toBe('unknown');
  });

  it('429 / 5xx / network -> unknown', async () => {
    expect((await createAtsClient(fakeFetch(() => ({ status: 429 }))).check(ref)).state).toBe('unknown');
    expect((await createAtsClient(fakeFetch(() => ({ status: 503 }))).check(ref)).state).toBe('unknown');
    const boom = fakeFetch(() => {
      throw new Error('ECONNRESET');
    });
    expect(await createAtsClient(boom).check(ref)).toMatchObject({ state: 'unknown', status: 0 });
  });
});

describe('lever (recorded)', () => {
  const ref = { type: 'lever', company: 'leverdemo', postingId: LV_ID, region: 'us' } as const;

  it('200 -> open', async () => {
    const f = fakeFetch((u) => (u === leverPostingUrl(ref) ? { status: 200, body: recorded('lever_posting_200.json') } : undefined));
    const res = await createAtsClient(f).check(ref);
    expect(res.state).toBe('open');
    if (res.state !== 'open') return;
    expect(res.posting.title).toBe('Customer Success Manager');
    expect(res.posting.workplace).toBe('hybrid');
    expect(res.posting.text).toContain('3+ years of account management');
    expect(res.posting.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('404 on a live company board -> closed', async () => {
    const f = fakeFetch((u) =>
      u.includes('?mode=json')
        ? { status: 200, body: recorded('lever_board_200.json') }
        : { status: 404, body: recorded('lever_posting_404.json') },
    );
    expect((await createAtsClient(f).check(ref)).state).toBe('closed');
  });

  it('404 when the company board is gone too -> unknown', async () => {
    const f = fakeFetch(() => ({ status: 404, body: recorded('lever_posting_404.json') }));
    expect(await createAtsClient(f).check(ref)).toMatchObject({ state: 'unknown', reason: 'lever company board not found' });
  });
});

describe('ashby (recorded)', () => {
  const ref = { type: 'ashby', board: 'linear', jobId: AB_ID } as const;

  it('job on board -> open; absent -> closed; one board call per run', async () => {
    const f = fakeFetch((u) => (u === ashbyBoardUrl('linear') ? { status: 200, body: recorded('ashby_board_200.json') } : undefined));
    const client = createAtsClient(f);
    const open = await client.check(ref);
    expect(open.state).toBe('open');
    if (open.state === 'open') {
      expect(open.posting.workplace).toBe('remote');
      expect(open.posting.text).toContain('product development system');
    }
    const gone = await client.check({ ...ref, jobId: '00000000-0000-0000-0000-000000000000' });
    expect(gone.state).toBe('closed');
    expect(f.calls).toHaveLength(1);
  });

  it('board 404 (plain-text body) -> unknown', async () => {
    const f = fakeFetch(() => ({ status: 404, body: 'Not Found' }));
    expect(await createAtsClient(f).check(ref)).toMatchObject({ state: 'unknown', reason: 'ashby board not found' });
  });
});

describe('captureJd', () => {
  it('prefers the ATS API', async () => {
    const f = fakeFetch(() => ({ status: 200, body: recorded('greenhouse_job_200.json') }));
    const jd = await captureJd(`https://job-boards.greenhouse.io/vercel/jobs/${GH_JOB}`, f);
    expect(jd.source).toBe('ats_api');
  });

  it('falls back to page text', async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: page('<h1>Staff PM</h1><p>Own &amp; ship.</p><script>x()</script>', 'Staff PM | Acme'),
    }));
    const jd = await captureJd('https://careers.example.com/jobs/staff-pm', f);
    expect(jd).toMatchObject({ source: 'page', title: 'Staff PM | Acme' });
    if (jd.source === 'page') expect(jd.text).toBe('Staff PM\nOwn & ship.');
  });

  it('reports none on a dead page', async () => {
    expect(
      await captureJd(
        'https://careers.example.com/x',
        fakeFetch(() => ({ status: 404 })),
      ),
    ).toEqual({ source: 'none', reason: 'page status 404' });
  });
});

describe('htmlToText', () => {
  it('decodes entities and keeps block breaks', () => {
    expect(htmlToText('<p>A&nbsp;&amp;&#39;B&#x27;</p><ul><li>one</li><li>two</li></ul>')).toBe("A &'B'\none\ntwo");
  });
});
