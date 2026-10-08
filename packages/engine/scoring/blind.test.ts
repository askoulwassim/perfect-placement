import type { AskRequest, AskResult } from '@perfect-placement/contracts';
import { describe, expect, it } from 'vitest';
import { blindState, brandTerms, criterionRequests, judgeCriteria, leaksBrand, MASK, maskText, OPEN_CRITERIA } from './blind.js';

const brand = { name: 'Northwind Labs', slug: 'northwind-labs', domain: 'northwind.io', terms: ['Windmill'] };
const role = {
  role_id: 'northwind-labs_principal-pm',
  title: 'Principal PM, Northwind Data',
  jd: "At Northwind Labs we build Windmill. Northwind's data team ships fast. Apply at https://jobs.northwind.io/123. Not to be confused with Northwindy Inc.",
  location: 'Remote, US',
  workplace: 'remote',
};

describe('blind masking', () => {
  it('collects name, words, slug, domain and extra terms', () => {
    const t = brandTerms(brand);
    expect(t).toEqual(expect.arrayContaining(['Northwind Labs', 'Northwind', 'northwind-labs', 'northwind.io', 'Windmill']));
    expect(t).not.toContain('Labs');
  });
  it('masks names, possessives and urls, keeps other words', () => {
    const out = maskText(role.jd, brand);
    expect(leaksBrand(out, brand)).toBe(false);
    expect(out).toContain(`${MASK} data team`);
    expect(out).toContain('Northwindy');
    expect(out).not.toContain('https://');
  });
  it('blind state has no brand anywhere', () => {
    const s = blindState(role, brand);
    expect(Object.values(s).some((v) => leaksBrand(v, brand))).toBe(false);
    expect(s).not.toHaveProperty('company');
  });
  it('splits requests: C1 C2 C3 C4 C9 blind, the rest open', () => {
    const [blind, open] = criterionRequests(role, brand, 'profile');
    expect(blind.questions.map((q) => q.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c9']);
    expect(open.questions.map((q) => q.id)).toEqual([...OPEN_CRITERIA]);
    expect(JSON.stringify(blind.state)).not.toMatch(/\bnorthwind\b|windmill/i);
    expect(JSON.stringify(open.state)).toContain('Northwind Labs');
    expect(blind.decision).toBe('roles.criterion');
    expect(blind.impact).toBe('low');
  });
});

describe('judgeCriteria', () => {
  it('assembles C1..C9 from two resolver calls and surfaces human outcomes', async () => {
    const seen: AskRequest[] = [];
    const ask = async (req: AskRequest): Promise<AskResult> => {
      seen.push(req);
      return {
        answers: req.questions.map((q) => ({ id: q.id, value: q.id === 'c6' ? 2 : 4, p: q.id === 'c6' ? 0.5 : 0.95 })),
        backend: 'jev',
        latencyMs: 1,
        decisionIds: req.questions.map((q) => `dc_${q.id}`),
        outcomes: req.questions.map((q) => (q.id === 'c6' ? 'human' : 'auto')),
      };
    };
    const r = await judgeCriteria(ask, role, brand, 'profile');
    expect(seen).toHaveLength(2);
    expect(r.criteria).toEqual({ c1: 4, c2: 4, c3: 4, c4: 4, c5: 4, c6: 2, c7: 4, c8: 4, c9: 4 });
    expect(r.needs_human).toEqual(['c6']);
    expect(r.decision_ids).toHaveLength(9);
  });
});
