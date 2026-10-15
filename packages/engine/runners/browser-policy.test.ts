import { describe, expect, it } from 'vitest';
import {
  ADAPTER_TOOLS,
  ATS_SITES,
  browserPolicy,
  LINKEDIN_SITES,
  parseBrowserPolicy,
  SIGN_IN_SITES,
  siteAllowed,
  siteOf,
  skillSites,
} from './browser-policy.js';
import { skillCapabilities } from './grants.js';

describe('browser run policy (#161)', () => {
  it('names a URL by its registrable site, with country second-level domains', () => {
    expect(siteOf('https://careers.acme.com/jobs/1')).toBe('acme.com');
    expect(siteOf('https://jobs.acme.co.uk/apply')).toBe('acme.co.uk');
    expect(siteOf('https://acme.io')).toBe('acme.io');
    expect(siteOf('https://boards.greenhouse.io/acme/jobs/1')).toBe('greenhouse.io');
    expect(siteOf('http://127.0.0.1:8080/x')).toBe('127.0.0.1');
    expect(siteOf('mailto:a@acme.com')).toBeNull();
    expect(siteOf('not a url')).toBeNull();
    expect(siteOf(null)).toBeNull();
  });

  it('allows a listed host and its subdomains, never a look-alike or a non-web URL', () => {
    const sites = ['acme.com', 'accounts.google.com'];
    for (const url of [
      'https://acme.com',
      'https://jobs.acme.com/apply?x=1',
      'http://acme.com.',
      'https://accounts.google.com/signin',
      'about:blank',
    ])
      expect(siteAllowed(url, sites), url).toBe(true);
    for (const url of [
      'https://acme.com.evil.test/',
      'https://notacme.com/',
      'https://mail.google.com/',
      'https://google.com/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'chrome://settings',
      'about:config',
    ])
      expect(siteAllowed(url, sites), url).toBe(false);
  });

  it("gives fill the role's own sites plus ATS and sign-in, LinkedIn skills LinkedIn, and others nothing", () => {
    const fill = skillSites('fill', {
      urls: ['https://www.linkedin.com/jobs/view/1', 'https://acme.wd5.myworkdayjobs.com/x', null],
      companyDomain: 'acme.com',
    });
    expect(fill.slice(0, 3)).toEqual(['linkedin.com', 'myworkdayjobs.com', 'acme.com']);
    expect(fill).toEqual(expect.arrayContaining([...ATS_SITES, ...SIGN_IN_SITES]));
    expect(new Set(fill).size).toBe(fill.length);
    expect(skillSites('fill')).toEqual([...new Set([...ATS_SITES, ...SIGN_IN_SITES])]);
    expect(skillSites('connect', { urls: ['https://acme.com'] })).toEqual([...LINKEDIN_SITES]);
    expect(skillSites('voice')).toEqual([...LINKEDIN_SITES]);
    expect(skillSites('scout')).toEqual([]);
    // Sign-in hosts are exact: the policy never allows google.com, live.com or apple.com at large.
    expect(SIGN_IN_SITES.every((s) => s.split('.').length >= 3)).toBe(true);
  });

  it('turns grants into adapter tools, with uploads only for an upload grant and a rendered folder', () => {
    const caps = skillCapabilities('fill', { assist: true });
    expect(browserPolicy({ caps, filesDir: '/v/files/r', sites: ['acme.com'] })).toEqual({
      tools: ['list_pages', 'new_page', 'close_page', 'navigate_page', 'take_snapshot', 'fill_form', 'upload_file'],
      uploads: ['/v/files/r/resume.pdf', '/v/files/r/cover_letter.pdf'],
      sites: ['acme.com'],
    });
    expect(browserPolicy({ caps, sites: [] }).tools).not.toContain('upload_file');
    expect(browserPolicy({ caps: skillCapabilities('fill', { assist: false }), filesDir: '/v/files/r', sites: [] })).toMatchObject({
      tools: ['list_pages', 'new_page', 'close_page', 'navigate_page', 'take_snapshot'],
      uploads: [],
    });
    expect(browserPolicy({ caps: skillCapabilities('inbox'), sites: [] }).tools).toEqual([]);
  });

  it('reads a policy from the command line and refuses a malformed one', () => {
    const good = { tools: ['list_pages', 'upload_file'], uploads: ['/v/files/r/resume.pdf'], sites: ['acme.com'] };
    expect(parseBrowserPolicy(JSON.stringify(good))).toEqual(good);
    for (const bad of [
      {},
      { ...good, tools: ['click'] },
      { ...good, uploads: ['files/r/resume.pdf'] },
      { ...good, tools: ['list_pages'] },
      { ...good, sites: ['https://acme.com/'] },
      { ...good, sites: 'acme.com' },
    ])
      expect(() => parseBrowserPolicy(JSON.stringify(bad)), JSON.stringify(bad)).toThrow();
    expect(() => parseBrowserPolicy('not json')).toThrow();
    expect(ADAPTER_TOOLS).toEqual(['list_pages', 'new_page', 'close_page', 'navigate_page', 'take_snapshot', 'fill_form', 'upload_file']);
  });
});
