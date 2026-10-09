/*
 * Job aggregators (#32): pages that list someone else's posting. Scout never stores these; it resolves
 * them to the company's own ATS posting or skips the hit.
 */

const EXACT: Record<string, string> = {
  'lnkd.in': 'linkedin',
  'ziprecruiter.com': 'ziprecruiter',
  'monster.com': 'monster',
  'simplyhired.com': 'simplyhired',
  'wellfound.com': 'wellfound',
  'angel.co': 'wellfound',
  'otta.com': 'otta',
  'welcometothejungle.com': 'welcometothejungle',
  'dice.com': 'dice',
  'levels.fyi': 'levels.fyi',
  'jobright.ai': 'jobright',
  'himalayas.app': 'himalayas',
  'remoteok.com': 'remoteok',
  'remoteok.io': 'remoteok',
  'weworkremotely.com': 'weworkremotely',
  'remotive.com': 'remotive',
  'workingnomads.com': 'workingnomads',
  'jooble.org': 'jooble',
  'talent.com': 'talent.com',
  'careerbuilder.com': 'careerbuilder',
  'theladders.com': 'theladders',
  'jobgether.com': 'jobgether',
  'flexjobs.com': 'flexjobs',
  'hiring.cafe': 'hiring.cafe',
  'startup.jobs': 'startup.jobs',
  'trueup.io': 'trueup',
  'builtin.com': 'builtin',
};

/** Brand-level patterns: any TLD or city variant (indeed.co.uk, builtinboston.com, de.glassdoor.ch). */
const PATTERNS: Array<[RegExp, string]> = [
  [/(^|\.)linkedin\.com$/, 'linkedin'],
  [/(^|\.)indeed\.[a-z.]+$/, 'indeed'],
  [/(^|\.)glassdoor\.[a-z.]+$/, 'glassdoor'],
  [/(^|\.)adzuna\.[a-z.]+$/, 'adzuna'],
  [/(^|\.)builtin[a-z]*\.com$/, 'builtin'],
  [/(^|\.)google\.[a-z.]+$/, 'google'],
];

/** The aggregator a URL belongs to, or null for a company's own page / ATS posting. */
export function aggregatorOf(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  for (const [domain, name] of Object.entries(EXACT)) if (host === domain || host.endsWith(`.${domain}`)) return name;
  for (const [re, name] of PATTERNS) if (re.test(host)) return name;
  return null;
}
