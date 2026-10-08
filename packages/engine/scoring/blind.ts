import {
  type AskFn,
  type AskRequest,
  BLIND_CRITERIA,
  CRITERIA,
  CRITERION_LABELS,
  type Criterion,
  type Question,
} from '@perfect-placement/contracts';

/*
 * Blind role scoring (decisions.md #5): the state the resolver sees for C1, C2, C3, C4, C9
 * has the company name and brand terms masked. C5..C8 (domain, comp, team, growth) see the company.
 */

export const MASK = '[company]';

export const BLIND_SET: ReadonlySet<Criterion> = new Set(BLIND_CRITERIA);
export const OPEN_CRITERIA: readonly Criterion[] = CRITERIA.filter((c) => !BLIND_SET.has(c));

export interface BrandInput {
  name: string;
  slug?: string | null;
  domain?: string | null;
  /** Product names, ticker, founders, etc. The score skill may add these. */
  terms?: readonly string[];
}

const GENERIC = new Set([
  'inc',
  'llc',
  'ltd',
  'corp',
  'co',
  'the',
  'ai',
  'labs',
  'lab',
  'hq',
  'technologies',
  'technology',
  'software',
  'group',
]);

/** All strings that identify the company, longest first. */
export function brandTerms(b: BrandInput): string[] {
  const set = new Set<string>();
  const add = (s: string | null | undefined) => {
    const t = s?.trim();
    if (t && t.length >= 2) set.add(t);
  };
  add(b.name);
  for (const w of b.name.split(/[\s,.]+/)) if (w.length >= 3 && !GENERIC.has(w.toLowerCase())) add(w);
  add(b.slug);
  add(b.slug?.replace(/-/g, ' '));
  if (b.domain) {
    add(b.domain);
    add(b.domain.split('.')[0]);
  }
  for (const t of b.terms ?? []) add(t);
  return [...set].sort((a, b2) => b2.length - a.length);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Replace every brand term (case-insensitive, whole word, possessives and URLs included) with MASK. */
export function maskText(text: string, b: BrandInput): string {
  let out = text.replace(/\bhttps?:\/\/\S+/gi, (url) =>
    brandTerms(b).some((t) => url.toLowerCase().includes(t.toLowerCase())) ? MASK : url,
  );
  for (const t of brandTerms(b)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${esc(t)}(?:['’]s)?(?![\\p{L}\\p{N}])`, 'giu'), MASK);
  }
  return out;
}

/** True if any brand term survives in the text (a leak check for tests and doctor). */
export function leaksBrand(text: string, b: BrandInput): boolean {
  return brandTerms(b).some((t) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(t)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
}

export interface RoleForJudging {
  role_id: string;
  title: string;
  jd: string;
  location?: string | null;
  workplace?: string | null;
  comp?: string | null;
}

/** Resolver state for the blind criteria: no company name, no brand terms, no URL. */
export function blindState(role: RoleForJudging, brand: BrandInput): Record<string, string> {
  return {
    title: maskText(role.title, brand),
    job_description: maskText(role.jd, brand),
    location: maskText(role.location ?? '', brand),
    workplace: role.workplace ?? '',
  };
}

/** Resolver state for the open criteria (C5..C8). */
export function openState(role: RoleForJudging, brand: BrandInput, profileSummary: string): Record<string, string> {
  return {
    company: brand.name,
    title: role.title,
    job_description: role.jd,
    location: role.location ?? '',
    workplace: role.workplace ?? '',
    comp: role.comp ?? '',
    candidate_profile: profileSummary,
  };
}

export const CRITERION_PROMPTS: Record<Criterion, string> = {
  c1: 'Proximity to decisions: how close does this role sit to the people who set strategy and budget? 1 far, 5 at the table.',
  c2: '0-to-1 scope: how much of the role is building something new rather than maintaining? 1 maintenance, 5 greenfield.',
  c3: 'External-facing: how much is the role facing customers, partners or the market? 1 internal only, 5 mostly external.',
  c4: 'Data fundamentals: how central are data platforms, data products or AI to the role? 1 incidental, 5 core.',
  c5: 'Domain excitement: how well does the problem space match the candidate profile? 1 poor, 5 ideal.',
  c6: 'Comp and equity versus the candidate floor and target. 1 well below, 5 at or above target.',
  c7: 'Team and leaders: strength of the team and reporting line. 1 weak, 5 exceptional.',
  c8: 'Growth ceiling: room to grow scope and level. 1 capped, 5 open.',
  c9: 'Role shape: does the role match the target function and level? 1 wrong shape, 5 exact.',
};

export function criterionQuestion(c: Criterion): Question {
  return { id: c, type: 'score', instructions: `${CRITERION_LABELS[c]}. ${CRITERION_PROMPTS[c]}`, min: 1, max: 5 };
}

/** Two resolver requests: blind (masked state) and open. Decision kind `roles.criterion`, low impact. */
export function criterionRequests(role: RoleForJudging, brand: BrandInput, profileSummary: string): [AskRequest, AskRequest] {
  const subject = { type: 'role', id: role.role_id };
  return [
    {
      decision: 'roles.criterion',
      impact: 'low',
      state: blindState(role, brand),
      questions: BLIND_CRITERIA.map(criterionQuestion),
      subject,
    },
    {
      decision: 'roles.criterion',
      impact: 'low',
      state: openState(role, brand, profileSummary),
      questions: OPEN_CRITERIA.map(criterionQuestion),
      subject,
    },
  ];
}

export interface JudgedCriteria {
  criteria: Record<Criterion, number>;
  p: Record<Criterion, number>;
  /** Criteria whose policy outcome was `human`: the skill must not call roles.score until they are resolved. */
  needs_human: Criterion[];
  decision_ids: string[];
}

/** Ask the resolver for C1..C9 (blind where required). Mechanics only; the backends supply judgment. */
export async function judgeCriteria(ask: AskFn, role: RoleForJudging, brand: BrandInput, profileSummary: string): Promise<JudgedCriteria> {
  const reqs = criterionRequests(role, brand, profileSummary);
  const results = await Promise.all(reqs.map((r) => ask(r)));
  const criteria = {} as Record<Criterion, number>;
  const p = {} as Record<Criterion, number>;
  const needs_human: Criterion[] = [];
  const decision_ids: string[] = [];
  for (const res of results) {
    decision_ids.push(...res.decisionIds);
    res.answers.forEach((a, i) => {
      const c = a.id as Criterion;
      const v = Math.round(Number(a.value));
      criteria[c] = Math.max(1, Math.min(5, Number.isFinite(v) ? v : 1));
      p[c] = a.p;
      if (res.outcomes[i] === 'human') needs_human.push(c);
    });
  }
  for (const c of CRITERIA) if (criteria[c] === undefined) throw new Error(`resolver returned no answer for ${c}`);
  return { criteria, p, needs_human, decision_ids };
}
