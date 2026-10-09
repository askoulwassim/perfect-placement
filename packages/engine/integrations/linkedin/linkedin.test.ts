import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertReadOnlyUrl,
  canonicalProfileUrl,
  companyPeopleUrl,
  connectionsSearchUrl,
  createLinkedInAdapter,
  createRecordedDriver,
  type LinkedInDriver,
  normalizeCard,
  SYNTHETIC_RECORDING,
  titleKeywords,
} from './index.js';

const req = { companyName: 'Linear', companyLinkedInSlug: 'linear', roleTitle: 'Product Lead, Insights', maxProfiles: 40 };

describe('read-only guard', () => {
  it('allows people listings', () => {
    expect(() => assertReadOnlyUrl(connectionsSearchUrl('Sendbird Connect'))).not.toThrow();
    expect(() => assertReadOnlyUrl(companyPeopleUrl('linear', 'Product Lead'))).not.toThrow();
  });
  it.each([
    'https://www.linkedin.com/messaging/thread/123/',
    'https://www.linkedin.com/mynetwork/invite-connect/connections/',
    'https://www.linkedin.com/in/fixture-maya-r/',
    'https://www.linkedin.com/feed/',
    'https://evil.example.com/search/results/people/',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => assertReadOnlyUrl(url)).toThrow(/guard refused/);
  });
});

describe('normalization', () => {
  it('canonicalizes profile URLs and strips everything but the allowed fields', () => {
    expect(canonicalProfileUrl('/in/Fixture-Maya-R/?miniProfile=abc')).toBe('https://www.linkedin.com/in/fixture-maya-r');
    expect(canonicalProfileUrl('https://example.com/in/x')).toBeNull();
    const p = normalizeCard(
      { name: '  Maya   R. ', headline: 'Head of Product', profileUrl: '/in/fixture-maya-r', degreeLabel: '1st', extra: 'phone' } as never,
      'company_people',
    );
    expect(p).toEqual({
      name: 'Maya R.',
      headline: 'Head of Product',
      url: 'https://www.linkedin.com/in/fixture-maya-r',
      degree: '1',
      via: null,
      found_on: 'company_people',
    });
    expect(normalizeCard({ name: 'LinkedIn Member', profileUrl: '/in/x', degreeLabel: '3rd+' }, 'company_people')).toBeNull();
  });
  it('drops seniority and filler words from title keywords', () => {
    expect(titleKeywords('Principal PM, Data Platform')).toBe('pm data platform');
  });
});

describe('adapter', () => {
  it('reads connections, the People page and mutuals; 2nd degree gets its mutual', async () => {
    const driver = createRecordedDriver(SYNTHETIC_RECORDING);
    const sleeps: number[] = [];
    const li = createLinkedInAdapter({
      driver,
      mode: 'dry-run',
      minDelayS: 20,
      sleep: async (ms) => void sleeps.push(ms),
      random: () => 0.5,
    });
    const r = await li.collect(req);
    const byName = Object.fromEntries(r.people.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(['Dev P.', 'Lina K.', 'Maya R.', 'Priya T.', 'Sam H.']);
    expect(byName['Maya R.']?.degree).toBe('1');
    expect(byName['Lina K.']?.degree).toBe('2');
    expect(byName['Lina K.']?.via?.name).toBe('Dev P.');
    expect(byName['Priya T.']?.degree).toBe('cold');
    expect(r.pagesOpened).toBe(3);
    expect(r.profilesRead).toBe(8);
    expect(r.capped).toBe(false);
    // Randomized delay before every page: min .. 2 x min.
    expect(sleeps).toEqual([30000, 30000, 30000]);
    for (const url of driver.opened) expect(() => assertReadOnlyUrl(url)).not.toThrow();
  });

  it('stops at the daily budget and reports capped', async () => {
    const driver = createRecordedDriver(SYNTHETIC_RECORDING);
    const li = createLinkedInAdapter({ driver, mode: 'dry-run', minDelayS: 0 });
    const r = await li.collect({ ...req, maxProfiles: 3 });
    expect(r.profilesRead).toBe(3);
    expect(r.capped).toBe(true);
    expect(driver.opened).toHaveLength(2);
    const none = await li.collect({ ...req, maxProfiles: 0 });
    expect(none.pagesOpened).toBe(0);
    expect(none.capped).toBe(true);
  });

  it('respects the page cap', async () => {
    const driver = createRecordedDriver(SYNTHETIC_RECORDING);
    const r = await createLinkedInAdapter({ driver, mode: 'dry-run', minDelayS: 0 }).collect({ ...req, maxPages: 1 });
    expect(r.pagesOpened).toBe(1);
    expect(r.capped).toBe(true);
  });

  it('has no engine-side live path (#82): live reads are agent-side', () => {
    const live = { kind: 'claude-in-chrome', open: async () => {}, readPeopleCards: async () => [] } as unknown as LinkedInDriver;
    expect(() =>
      createLinkedInAdapter({ driver: createRecordedDriver(SYNTHETIC_RECORDING), mode: 'live' as never, minDelayS: 20 }),
    ).toThrow(/agent-side/);
    expect(() => createLinkedInAdapter({ driver: live, mode: 'dry-run', minDelayS: 20 })).toThrow(/agent-side/);
  });

  it('never opens a page the guard refuses, even if a recording hands it one', async () => {
    const driver = createRecordedDriver({
      pages: {
        '/company/linear/people': [
          { name: 'X Y.', profileUrl: '/in/x', degreeLabel: '2nd', mutualsUrl: 'https://www.linkedin.com/messaging/compose/' },
        ],
      },
    });
    const li = createLinkedInAdapter({ driver, mode: 'dry-run', minDelayS: 0 });
    await expect(li.collect(req)).rejects.toThrow(/guard refused/);
    expect(driver.opened.some((u) => u.includes('messaging'))).toBe(false);
  });

  it('the driver contract has no write capability', () => {
    const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const iface = src.slice(
      src.indexOf('export interface LinkedInDriver'),
      src.indexOf('}', src.indexOf('export interface LinkedInDriver')),
    );
    expect(iface).toMatch(/open\(url: string\)/);
    expect(iface).toMatch(/readPeopleCards\(\)/);
    expect(iface).not.toMatch(/click|type\(|fill|evaluate|send|connect\(/i);
  });
});
