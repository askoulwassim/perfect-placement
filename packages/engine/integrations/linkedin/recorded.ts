import type { LinkedInDriver, RawPeopleCard } from './index.js';

/*
 * Recorded driver for dry-run mode and tests. Serves people cards keyed by URL path
 * (`/search/results/people`, `/company/<slug>/people`, or a full mutuals URL). Never touches a network.
 * All people here are synthetic placeholders.
 */

export interface Recording {
  /** Key: URL pathname, or full URL for exact matches (checked first). */
  pages: Record<string, RawPeopleCard[]>;
}

export interface RecordedDriver extends LinkedInDriver {
  readonly kind: 'recorded';
  /** URLs opened, in order (tests assert caps and the read-only guard on this). */
  readonly opened: string[];
}

export function createRecordedDriver(recording: Recording): RecordedDriver {
  const opened: string[] = [];
  let current: string | null = null;
  return {
    kind: 'recorded',
    opened,
    async open(url) {
      opened.push(url);
      current = url;
    },
    async readPeopleCards() {
      if (!current) return [];
      const exact = recording.pages[current];
      if (exact) return exact.map((c) => ({ ...c }));
      const path = new URL(current).pathname.replace(/\/$/, '');
      return (recording.pages[path] ?? []).map((c) => ({ ...c }));
    },
  };
}

const MUTUALS_URL = 'https://www.linkedin.com/search/results/people/?facetConnectionOf=%5B%22fixture-lina%22%5D&network=%5B%22F%22%5D';

/** Synthetic recording for the fixture company `linear`. Placeholder people only. */
export const SYNTHETIC_RECORDING: Recording = {
  pages: {
    '/search/results/people': [
      {
        name: 'Maya R.',
        headline: 'Head of Product, Insights at Linear',
        profileUrl: 'https://www.linkedin.com/in/fixture-maya-r/?miniProfile=x',
        degreeLabel: '1st',
      },
      { name: 'Dev P.', headline: 'Engineering Manager at Linear', profileUrl: '/in/fixture-dev-p', degreeLabel: '1st' },
    ],
    '/company/linear/people': [
      {
        name: 'Lina K.',
        headline: 'Product Designer',
        profileUrl: 'https://www.linkedin.com/in/fixture-lina-k',
        degreeLabel: '2nd',
        mutualsUrl: MUTUALS_URL,
      },
      { name: 'Priya T.', headline: 'Staff Engineer', profileUrl: 'https://www.linkedin.com/in/fixture-priya-t', degreeLabel: '3rd+' },
      {
        name: 'Sam H.',
        headline: 'Director of Product, Data',
        profileUrl: 'https://www.linkedin.com/in/fixture-sam-h',
        degreeLabel: '3rd+',
      },
      {
        name: 'LinkedIn Member',
        headline: 'Product at Linear',
        profileUrl: 'https://www.linkedin.com/search/results/people/',
        degreeLabel: 'out_of_network',
      },
      {
        name: 'Maya R.',
        headline: 'Head of Product, Insights',
        profileUrl: 'https://www.linkedin.com/in/fixture-maya-r',
        degreeLabel: '1st',
      },
    ],
    [MUTUALS_URL]: [
      {
        name: 'Dev P.',
        headline: 'Engineering Manager at Linear',
        profileUrl: 'https://www.linkedin.com/in/fixture-dev-p',
        degreeLabel: '1st',
      },
    ],
  },
};
