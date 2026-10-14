import { describe, expect, it } from 'vitest';
import { atsFromUrl, normalizeUrl, titleSimilarity, titleTokens } from './dedupe.js';

describe('dedupe mechanics', () => {
  it('normalizes urls', () => {
    expect(normalizeUrl('https://www.Example.com/Jobs/1/?utm_source=x&b=2&a=1#top')).toBe('example.com/jobs/1?a=1&b=2');
    expect(normalizeUrl('https://boards.greenhouse.io/acme/jobs/123/')).toBe(
      normalizeUrl('https://boards.greenhouse.io/acme/jobs/123?gh_src=abc'),
    );
    expect(normalizeUrl(undefined)).toBeNull();
  });

  it('reads ATS type, board and job id from urls', () => {
    expect(atsFromUrl('https://boards.greenhouse.io/acme/jobs/4012345')).toEqual({ type: 'greenhouse', board: 'acme', jobId: '4012345' });
    expect(atsFromUrl('https://job-boards.greenhouse.io/acme/jobs/77')).toMatchObject({ jobId: '77' });
    expect(atsFromUrl('https://acme.com/careers?gh_jid=555')).toMatchObject({ type: 'greenhouse', jobId: '555' });
    expect(atsFromUrl('https://jobs.lever.co/acme/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b')).toMatchObject({ type: 'lever', board: 'acme' });
    expect(atsFromUrl('https://jobs.ashbyhq.com/acme/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b').type).toBe('ashby');
    expect(atsFromUrl('https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Remote/Staff-PM_R12345')).toMatchObject({
      type: 'workday',
      jobId: 'R12345',
    });
    expect(atsFromUrl('not a url').type).toBe('unknown');
  });

  it('matches ATS hosts by domain, not by suffix (#152)', () => {
    expect(atsFromUrl('https://evilgreenhouse.io/acme/jobs/4012345').type).toBe('unknown');
    expect(atsFromUrl('https://acme.notmyworkdayjobs.com/en-US/careers/job/Remote/Staff-PM_R12345').type).toBe('unknown');
    expect(atsFromUrl('https://greenhouse.io/acme/jobs/4012345')).toMatchObject({ type: 'greenhouse', jobId: '4012345' });
  });

  it('trims trailing slashes, including from text that is not a url', () => {
    expect(normalizeUrl('https://example.com/jobs/1///')).toBe('example.com/jobs/1');
    expect(normalizeUrl('Acme careers///')).toBe('acme careers');
  });

  it('fuzzy titles: abbreviations and noise collapse, different scopes stay apart', () => {
    expect([...titleTokens('Sr. PM, AI Platform (Remote)')].sort()).toEqual(['ai', 'manager', 'platform', 'product', 'senior']);
    expect(titleSimilarity('Principal PM, AI Platform', 'Principal Product Manager - AI Platform')).toBe(1);
    expect(titleSimilarity('Staff PM, Data Platform', 'Staff PM, Data Pipelines')).toBeLessThan(0.9);
    expect(titleSimilarity('Staff PM, Data Platform', 'Staff PM, Data Pipelines')).toBeGreaterThanOrEqual(0.6);
    expect(titleSimilarity('Head of Design', 'Staff Engineer, Billing')).toBeLessThan(0.2);
  });
});
