import { PROFILE_COMPONENT_KIND, type ProfileComponentKey } from '@perfect-placement/contracts';

/*
 * LOCAL SHIM for lane E (profile). Lane E owns the component model and the converter from v1
 * profile files to structured components. Until E merges, `pp migrate` lands v1 profile material
 * as stub components keyed by the contract PROFILE_COMPONENT_KEYS: long-form text goes to
 * profile/<key>.md, rubric facts go to data_json verbatim, and every data_json carries
 * `stub: 'v1'` so lane E's converter can find and replace them. Weights stay null: turning v1
 * criterion weights into component weights is lane E / F judgment.
 */

export interface V1Rubric {
  version?: string;
  updated?: string;
  weights?: Record<string, number>;
  criteria?: Record<string, string>;
  bands?: Record<string, unknown>;
  decision_rule?: string;
  dealbreakers?: Record<string, unknown>;
  dream_companies?: string[];
  [k: string]: unknown;
}

/** v1 files (01_Profile/*) that feed each long-form component, in order. */
export const V1_PROFILE_SOURCES: Partial<Record<ProfileComponentKey, string[]>> = {
  story: ['01_Profile/resume_master.md', '01_Profile/stories.md'],
  voice: ['01_Profile/positioning.md', '01_Profile/application_defaults.md'],
  craft: ['01_Profile/perfect_role.md'],
};

/** Which v1 rubric criteria inform each weighted/filter component (reference only, for lane E/F). */
export const V1_CRITERIA_FOR: Partial<Record<ProfileComponentKey, string[]>> = {
  craft: ['C1', 'C2', 'C3', 'C4', 'C9'],
  domain: ['C5'],
  terms: ['C6'],
  team: ['C7'],
  growth: ['C8'],
};

export interface StubComponent {
  key: ProfileComponentKey;
  kind: (typeof PROFILE_COMPONENT_KIND)[ProfileComponentKey];
  confidence: number;
  data: Record<string, unknown>;
  /** Long-form markdown body (no frontmatter), or null. */
  body: string | null;
}

/** Build the 11 stub components from v1 profile files (`read` returns file text or null) and rubric.json. */
export function stubComponents(read: (rel: string) => string | null, rubric: V1Rubric | null): StubComponent[] {
  const pick = (ids: string[] | undefined) =>
    ids && rubric
      ? Object.fromEntries(ids.map((c) => [c, { label: rubric.criteria?.[c] ?? null, weight: rubric.weights?.[c] ?? null }]))
      : undefined;
  const longForm = (key: ProfileComponentKey): { body: string | null; sources: string[] } => {
    const parts: string[] = [];
    const sources: string[] = [];
    for (const rel of V1_PROFILE_SOURCES[key] ?? []) {
      const text = read(rel);
      if (text === null) continue;
      sources.push(rel);
      parts.push(`<!-- v1: ${rel} -->\n\n${text.trim()}`);
    }
    return { body: parts.length ? parts.join('\n\n') : null, sources };
  };
  const dealbreakers = rubric?.dealbreakers ?? {};
  const facts: Partial<Record<ProfileComponentKey, Record<string, unknown>>> = {
    work_mode: { remote_required_unless_dream_co: dealbreakers.remote_required_unless_dream_co ?? null },
    terms: {
      comp_floor: dealbreakers.comp_floor ?? null,
      comp_heavy_penalty_below: dealbreakers.comp_heavy_penalty_below ?? null,
      currency: 'USD',
    },
    company: { dream_companies: rubric?.dream_companies ?? [] },
    dealbreakers: { ...dealbreakers },
  };

  const hasCraftMd = (V1_PROFILE_SOURCES.craft ?? []).some((rel) => read(rel) !== null);
  return (Object.keys(PROFILE_COMPONENT_KIND) as ProfileComponentKey[]).map((key) => {
    const { body, sources } = longForm(key);
    const criteria = pick(V1_CRITERIA_FOR[key]);
    const data: Record<string, unknown> = { stub: 'v1', sources, ...(facts[key] ?? {}) };
    if (criteria) data.v1_criteria = criteria;
    if (rubric?.version) data.v1_rubric_version = rubric.version;
    if (hasCraftMd && ['domain', 'company', 'team', 'growth', 'work_mode', 'dealbreakers'].includes(key)) data.see = 'profile/craft.md';
    const fromRubric = key in facts && rubric !== null;
    return { key, kind: PROFILE_COMPONENT_KIND[key], confidence: fromRubric ? 0.8 : 0.5, data, body };
  });
}
