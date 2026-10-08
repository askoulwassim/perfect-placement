import { describe, expect, it } from 'vitest';
import { fakeFetch, page } from '../integrations/ats/__fixtures__/fake-fetch.js';
import { checkPage, closedPhrase, isListingRedirect } from './page.js';

const GH = 'https://job-boards.greenhouse.io/vercel/jobs/7000001';

describe('page fallback', () => {
  it('404 / 410 -> closed', async () => {
    expect(
      (
        await checkPage(
          GH,
          fakeFetch(() => ({ status: 404 })),
        )
      ).signal,
    ).toBe('closed');
    expect(
      (
        await checkPage(
          GH,
          fakeFetch(() => ({ status: 410 })),
        )
      ).signal,
    ).toBe('closed');
  });

  it('Greenhouse redirect to /{board}?error=true -> closed', async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: page('<h1>Open roles</h1>'),
      finalUrl: 'https://job-boards.greenhouse.io/vercel?error=true',
    }));
    expect(await checkPage(GH, f)).toMatchObject({ signal: 'closed', finalUrl: 'https://job-boards.greenhouse.io/vercel?error=true' });
  });

  it('redirect that drops the job id -> closed; one that keeps it -> not', () => {
    expect(isListingRedirect('https://careers.acme.com/jobs/123456', 'https://careers.acme.com/jobs')).toBe(true);
    expect(
      isListingRedirect('https://boards.greenhouse.io/vercel/jobs/123456', 'https://job-boards.greenhouse.io/vercel/jobs/123456'),
    ).toBe(false);
    expect(isListingRedirect('https://acme.com/careers/staff-pm', 'https://acme.com/careers')).toBe(false); // no id to lose
    expect(isListingRedirect('https://acme.com/c?gh_jid=555555', 'https://acme.com/c')).toBe(true);
  });

  it('closed phrases -> closed', async () => {
    const f = fakeFetch(() => ({ status: 200, body: page('<div class="banner">No longer accepting applications</div><h1>Staff PM</h1>') }));
    const res = await checkPage('https://www.linkedin.com/jobs/view/1234567890', f);
    expect(res).toMatchObject({ signal: 'closed', reason: 'closed phrase: "no longer accepting applications"' });
    expect(closedPhrase('Sorry, this position has\n been filled.')).toBe('this position has been filled');
    expect(closedPhrase('The job you’re looking for is no longer here')).toBe("the job you're looking for is no longer");
  });

  it('Ashby SPA with posting null -> closed', async () => {
    const html =
      '<html><head><title>Jobs</title></head><body><script>window.__appData = {"organization":null,"posting":null};</script></body></html>';
    expect(
      (
        await checkPage(
          'https://jobs.ashbyhq.com/linear/x',
          fakeFetch(() => ({ status: 200, body: html })),
        )
      ).signal,
    ).toBe('closed');
  });

  it('bot walls and rate limits are inconclusive, never closed', async () => {
    for (const status of [403, 429, 999, 503]) {
      const res = await checkPage(
        GH,
        fakeFetch(() => ({ status })),
      );
      expect(res).toMatchObject({ signal: 'inconclusive', blocked: true });
    }
    const boom = fakeFetch(() => {
      throw new Error('timeout');
    });
    expect(await checkPage(GH, boom)).toMatchObject({ signal: 'inconclusive', blocked: true, status: 0 });
  });

  it('a live-looking page is inconclusive and carries text for the resolver', async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: page('<h1>Staff PM, AI</h1><p>We build things.</p><button>Apply for this job</button>'),
    }));
    const res = await checkPage(GH, f, 20);
    expect(res).toMatchObject({ signal: 'inconclusive', blocked: false, title: 'Job' });
    expect(res.text).toHaveLength(20);
  });
});
