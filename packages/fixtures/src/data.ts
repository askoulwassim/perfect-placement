/*
 * SYNTHETIC fixture data. Nothing here comes from a real person's pipeline or profile.
 * Companies are public names; titles are made up; people are placeholders (first name + initial).
 * Edit this file, then `pnpm --filter @perfect-placement/fixtures gen` to regenerate seed + vault.
 */
import {
  type Application,
  type ArchiveReason,
  type AskThreadRow,
  type Band,
  type Company,
  type Contact,
  type ContactLink,
  CRITERIA,
  CRITERION_OWNER,
  type Criterion,
  DEFAULT_CONFIG,
  type Decision,
  DREAM_AFFINITY,
  type EventRow,
  type Interview,
  type OnboardSession,
  type Outreach,
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  type ProfileComponent,
  type ProfileComponentKey,
  type ProfileDiff,
  type ProfileVersion,
  type Role,
  type RoleStatus,
  type RubricSnapshot,
  type Run,
  type Score,
  type ScoreDecision,
  vaultPath,
  type Workplace,
} from '@perfect-placement/contracts';

export const FIXTURE_NOW = '2026-10-08T12:00:00.000Z';
const day = 86_400_000;
const at = (daysAgo: number, hour = 9) => new Date(Date.parse('2026-10-08T00:00:00.000Z') - daysAgo * day + hour * 3_600_000).toISOString();
const pad = (n: number) => String(n).padStart(4, '0');

// ------------------------------------------------------------------ profile

const WEIGHTS: Record<Criterion, number> = { c1: 15, c2: 12, c3: 10, c4: 12, c5: 12, c6: 10, c7: 10, c8: 9, c9: 10 };

/** The fixture rubric (RubricSnapshot, v1 scale: wave1-decisions #11). Score rows carry their own profile_version_id. */
export const RUBRIC = {
  version: 'fixture-2',
  scale: 'v1',
  weights: WEIGHTS,
  bands: { green_min: DEFAULT_CONFIG.scoring.green_min, yellow_min: DEFAULT_CONFIG.scoring.yellow_min },
  affinity_cap: DEFAULT_CONFIG.scoring.affinity_cap,
  company_active_cap: DEFAULT_CONFIG.scoring.company_active_cap,
  profile_version_id: 'pv_0002',
  weights_source: 'profile',
  formula: 'total = clamp(round(sum(c_i * w_i) / 5) + affinity_mod, 0, 100)',
} as const satisfies RubricSnapshot;

/** Owned criterion weights per component (CRITERION_OWNER), points of 100. */
const ownedWeights = (key: ProfileComponentKey): Partial<Record<Criterion, number>> =>
  Object.fromEntries(CRITERIA.filter((c) => CRITERION_OWNER[c] === key).map((c) => [c, WEIGHTS[c]]));

/** Dream companies get DREAM_AFFINITY (wave1-decisions #10), capped, never a dealbreaker bypass. */
const DREAM = ['linear', 'figma'] as const;

const COMPONENT_DATA: Record<ProfileComponentKey, { confidence: number; data: Record<string, unknown> }> = {
  story: {
    confidence: 0.9,
    data: {
      name: 'Sam Fixture',
      headline: 'Data platform product lead',
      years: 12,
      wins: ['Launched a self-serve analytics product to 400 teams', 'Cut pipeline cost 38% with a usage-based redesign'],
    },
  },
  craft: { confidence: 0.85, data: { functions: ['PM', 'TPM'], level: 'principal', mode: 'lead' } },
  domain: { confidence: 0.7, data: { ranked: ['data infrastructure', 'AI tooling', 'developer platforms', 'fintech'] } },
  work_mode: { confidence: 0.95, data: { modes: ['remote'], remote_only: true, locations: ['US'], travel_max_pct: 15 } },
  terms: { confidence: 0.8, data: { comp_floor: 200000, comp_target: 240000, currency: 'USD', equity: 'medium' } },
  company: {
    confidence: 0.6,
    data: {
      stages: ['series-b', 'series-c', 'public'],
      size: '200-5000',
      dream_companies: [...DREAM],
      affinity: Object.fromEntries(DREAM.map((d) => [d, DREAM_AFFINITY])),
      watchlist: ['linear', 'figma', 'stripe'],
    },
  },
  team: { confidence: 0.5, data: { proximity: 'reports to VP or above', prefers_small_teams: true } },
  growth: { confidence: 0.55, data: { scope_ceiling: 'head of product', trajectory: 'up' } },
  dealbreakers: { confidence: 1, data: { hard_nos: ['onsite only', 'ad tech', 'below comp floor'] } },
  voice: {
    confidence: 0.75,
    data: {
      style: 'punchy',
      rules: ['no em dashes', 'hook, reframe, close'],
      // Synthetic writing samples (style exemplars only; their facts are never reused).
      samples: [
        'Short version: the dashboard was fine, the questions were wrong. We fixed the questions first.',
        'Happy to dig in. Two things stood out, and one of them is a quick win.',
      ],
    },
  },
  network: { confidence: 0.4, data: { warm_companies: ['stripe', 'datadog', 'ramp'] } },
};

export const profileVersions: ProfileVersion[] = [
  { id: 'pv_0001', created_at: at(30), parent_id: null, reason: 'onboard', event_id: null },
  { id: 'pv_0002', created_at: at(10), parent_id: 'pv_0001', reason: 'calibration: domain reweighted', event_id: null },
];

/** `weight` column of a weighted component = owned criterion points / 100 (null for filters and assets). */
const weightOf = (key: ProfileComponentKey): number | null =>
  PROFILE_COMPONENT_KIND[key] === 'weighted' ? Object.values(ownedWeights(key)).reduce((a, b) => a + b, 0) / 100 : null;

export const profileComponents: ProfileComponent[] = profileVersions.flatMap((v, vi) =>
  PROFILE_COMPONENT_KEYS.map((key, ki) => {
    const kind = PROFILE_COMPONENT_KIND[key];
    const base = COMPONENT_DATA[key];
    const owned = ownedWeights(key);
    const data = {
      ...(key === 'domain' && vi === 0 ? { ranked: ['developer platforms', 'data infrastructure', 'fintech'] } : base.data),
      ...(Object.keys(owned).length ? { criterion_weights: owned } : {}),
    };
    return {
      id: `pc_${pad(vi * 100 + ki + 1)}`,
      version_id: v.id,
      key,
      kind,
      confidence: vi === 0 ? Math.max(0.3, base.confidence - 0.1) : base.confidence,
      weight: weightOf(key),
      data_json: data,
      md_path: key === 'story' || key === 'voice' ? vaultPath.profileComponent(key) : null,
    };
  }),
);

export const profileDiffs: ProfileDiff[] = [
  {
    id: 'pd_0001',
    created_at: at(1, 7),
    component_key: 'terms',
    base_version_id: 'pv_0002',
    diff_json: { before: { comp_floor: 200000 }, after: { comp_floor: 215000 } },
    evidence_json: ['3 roles skipped for comp', 'offer at 230k'],
    impact: 'high',
    status: 'pending',
    decision_id: 'dc_0003',
    event_id: null,
    applied_version_id: null,
  },
  {
    id: 'pd_0002',
    created_at: at(0, 6),
    component_key: 'domain',
    base_version_id: 'pv_0002',
    diff_json: { before: { ranked: ['data infrastructure', 'AI tooling'] }, after: { ranked: ['AI tooling', 'data infrastructure'] } },
    evidence_json: ['picked 4 of 5 AI tooling roles', 'skipped 3 data infra roles'],
    impact: 'medium',
    status: 'pending',
    decision_id: null,
    event_id: null,
    applied_version_id: null,
  },
];

// ---------------------------------------------------------------- companies

const COMPANIES: Array<[slug: string, name: string, domain: string, ats: Company['ats_type'], affinity: number]> = [
  ['stripe', 'Stripe', 'stripe.com', 'greenhouse', 1],
  ['datadog', 'Datadog', 'datadoghq.com', 'greenhouse', 0],
  ['figma', 'Figma', 'figma.com', 'greenhouse', DREAM_AFFINITY],
  ['notion', 'Notion', 'notion.so', 'ashby', 0],
  ['linear', 'Linear', 'linear.app', 'ashby', DREAM_AFFINITY],
  ['vercel', 'Vercel', 'vercel.com', 'greenhouse', 1],
  ['snowflake', 'Snowflake', 'snowflake.com', 'workday', 0],
  ['databricks', 'Databricks', 'databricks.com', 'greenhouse', 0],
  ['airtable', 'Airtable', 'airtable.com', 'greenhouse', -1],
  ['retool', 'Retool', 'retool.com', 'lever', 0],
  ['ramp', 'Ramp', 'ramp.com', 'ashby', 1],
  ['plaid', 'Plaid', 'plaid.com', 'lever', 0],
];

export const companies: Company[] = COMPANIES.map(([slug, name, domain, ats_type, affinity]) => ({
  id: slug,
  slug,
  name,
  domain,
  ats_type,
  ats_board: ats_type === 'workday' ? null : slug,
  affinity,
  md_path: ['stripe', 'linear', 'datadog'].includes(slug) ? vaultPath.dossier(slug) : null,
}));

// -------------------------------------------------------------------- roles

interface RoleSeed {
  co: string;
  title: string;
  status: RoleStatus;
  /** Nine 1..5 digits, c1..c9. Empty for unscored inbox roles. */
  c: string;
  wp: Workplace;
  found: number;
  reason?: ArchiveReason;
  fresh?: Role['freshness'];
  checked?: number;
  comp?: [number, number];
}

const ROLE_SEEDS: RoleSeed[] = [
  // inbox (unscored)
  { co: 'notion', title: 'Product Lead, Data Platform', status: 'inbox', c: '', wp: 'hybrid', found: 0 },
  { co: 'plaid', title: 'Staff PM, Data Products', status: 'inbox', c: '', wp: 'remote', found: 0 },
  { co: 'snowflake', title: 'Principal PM, AI Observability', status: 'inbox', c: '', wp: 'unspecified', found: 1 },
  // active
  {
    co: 'datadog',
    title: 'Principal PM, LLM Observability',
    status: 'active',
    c: '555455454',
    wp: 'remote',
    found: 6,
    fresh: 'open',
    checked: 0,
    comp: [230000, 280000],
  },
  { co: 'datadog', title: 'Staff PM, Data Pipelines', status: 'active', c: '545454444', wp: 'remote', found: 6, fresh: 'open', checked: 0 },
  { co: 'datadog', title: 'Group PM, Cloud Cost', status: 'active', c: '444454444', wp: 'hybrid', found: 9, fresh: 'unsure', checked: 1 },
  {
    co: 'linear',
    title: 'Product Lead, AI',
    status: 'active',
    c: '555545455',
    wp: 'remote',
    found: 3,
    fresh: 'open',
    checked: 0,
    comp: [220000, 260000],
  },
  {
    co: 'figma',
    title: 'Principal PM, Developer Platform',
    status: 'active',
    c: '544455544',
    wp: 'hybrid',
    found: 4,
    fresh: 'open',
    checked: 0,
  },
  { co: 'vercel', title: 'Staff PM, AI SDK', status: 'active', c: '454545445', wp: 'remote', found: 12, fresh: 'open', checked: 2 },
  { co: 'ramp', title: 'Senior PM, Data Intelligence', status: 'active', c: '445444544', wp: 'hybrid', found: 20, fresh: 'unknown' },
  { co: 'retool', title: 'Principal PM, Workflows', status: 'active', c: '454444454', wp: 'remote', found: 50, fresh: 'open', checked: 3 },
  {
    co: 'databricks',
    title: 'Staff PM, Lakehouse AI',
    status: 'active',
    c: '545444445',
    wp: 'remote',
    found: 8,
    fresh: 'open',
    checked: 0,
  },
  // held (Datadog over the cap of 3)
  {
    co: 'datadog',
    title: 'Senior PM, Synthetic Monitoring',
    status: 'held',
    c: '444444454',
    wp: 'remote',
    found: 5,
    fresh: 'open',
    checked: 0,
  },
  { co: 'datadog', title: 'PM, Data Jobs Monitoring', status: 'held', c: '444445444', wp: 'remote', found: 5, fresh: 'open', checked: 1 },
  // on-deck
  {
    co: 'stripe',
    title: 'Staff PM, Data Platform',
    status: 'on-deck',
    c: '555454545',
    wp: 'remote',
    found: 7,
    fresh: 'open',
    checked: 0,
    comp: [240000, 300000],
  },
  {
    co: 'airtable',
    title: 'Principal PM, AI Platform',
    status: 'on-deck',
    c: '454545444',
    wp: 'hybrid',
    found: 9,
    fresh: 'unsure',
    checked: 0,
  },
  { co: 'plaid', title: 'Principal PM, Identity', status: 'on-deck', c: '445454444', wp: 'remote', found: 11, fresh: 'open', checked: 1 },
  // draft-ready
  {
    co: 'linear',
    title: 'Product Lead, Insights',
    status: 'draft-ready',
    c: '555555454',
    wp: 'remote',
    found: 14,
    fresh: 'open',
    checked: 0,
  },
  { co: 'vercel', title: 'Principal PM, Data', status: 'draft-ready', c: '545455455', wp: 'remote', found: 15, fresh: 'open', checked: 0 },
  // applied
  {
    co: 'stripe',
    title: 'Principal PM, Revenue Data',
    status: 'applied',
    c: '555455545',
    wp: 'remote',
    found: 25,
    fresh: 'open',
    checked: 4,
  },
  { co: 'notion', title: 'Staff PM, AI Connectors', status: 'applied', c: '454555454', wp: 'hybrid', found: 22, fresh: 'open', checked: 6 },
  { co: 'databricks', title: 'Principal PM, Unity Catalog', status: 'applied', c: '545454554', wp: 'remote', found: 28, fresh: 'unknown' },
  // interviews
  { co: 'figma', title: 'Staff PM, Data Platform', status: 'interviews', c: '555454555', wp: 'remote', found: 35, fresh: 'unknown' },
  { co: 'ramp', title: 'Principal PM, AI Agents', status: 'interviews', c: '555545454', wp: 'hybrid', found: 32, fresh: 'unknown' },
  // offers
  { co: 'retool', title: 'Head of Data Product', status: 'offers', c: '555555455', wp: 'remote', found: 45, fresh: 'unknown' },
  // archived, one per reason
  {
    co: 'snowflake',
    title: 'Senior PM, Marketplace',
    status: 'archived',
    reason: 'below_threshold',
    c: '334333433',
    wp: 'hybrid',
    found: 18,
  },
  { co: 'airtable', title: 'Group PM, Ads', status: 'archived', reason: 'dealbreaker', c: '444344443', wp: 'onsite', found: 19 },
  {
    co: 'vercel',
    title: 'Staff PM, Edge Network',
    status: 'archived',
    reason: 'closed',
    c: '454444444',
    wp: 'remote',
    found: 26,
    fresh: 'closed',
    checked: 0,
  },
  { co: 'notion', title: 'Principal PM, Enterprise', status: 'archived', reason: 'rejected', c: '445444454', wp: 'hybrid', found: 40 },
  { co: 'plaid', title: 'Staff PM, Payments Data', status: 'archived', reason: 'passed', c: '454444445', wp: 'remote', found: 16 },
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const companyById = new Map(companies.map((c) => [c.id, c]));

export const roles: Role[] = ROLE_SEEDS.map((r, i) => {
  const id = `${r.co}_${slug(r.title)}`;
  const co = companyById.get(r.co);
  if (!co) throw new Error(`unknown company ${r.co}`);
  const atsHost =
    co.ats_type === 'greenhouse'
      ? `https://boards.greenhouse.io/${co.slug}/jobs/${7000000 + i}`
      : co.ats_type === 'lever'
        ? `https://jobs.lever.co/${co.slug}/${slug(r.title)}-${i}`
        : co.ats_type === 'ashby'
          ? `https://jobs.ashbyhq.com/${co.slug}/${slug(r.title)}-${i}`
          : `https://careers.${co.domain}/jobs/${slug(r.title)}`;
  return {
    id,
    company_id: r.co,
    title: r.title,
    url: atsHost,
    ats_job_id: co.ats_type === 'greenhouse' ? String(7000000 + i) : null,
    source: i % 4 === 0 ? 'watchlist' : i % 5 === 0 ? 'link' : 'scout',
    found_at: at(r.found, 8),
    posted_at: at(r.found + 3, 8),
    workplace: r.wp,
    remote_ok: r.wp === 'remote' ? true : r.wp === 'onsite' ? false : null,
    location: r.wp === 'remote' ? 'US' : 'New York, NY',
    comp_min: r.comp?.[0] ?? null,
    comp_max: r.comp?.[1] ?? null,
    comp_currency: r.comp ? 'USD' : null,
    facing: i % 3 === 0 ? 'external' : 'mixed',
    seniority: r.title.split(/[ ,]/)[0] ?? null,
    status: r.status,
    archive_reason: r.status === 'archived' ? (r.reason ?? 'passed') : null,
    held_reason: r.status === 'held' ? 'company_cap' : null,
    last_checked_at: r.checked === undefined ? null : at(r.checked, 6),
    freshness: r.fresh ?? 'unknown',
    flags_json: r.reason === 'dealbreaker' ? { dealbreaker: 'ad tech' } : {},
    md_path: vaultPath.role(id),
    created_at: at(r.found, 8),
    updated_at: at(Math.max(0, r.found - 1), 8),
  };
});

// ------------------------------------------------------------------- scores

/** v1 scale: clamp(round(sum(c_i * w_i) / 5) + affinity, 0, 100). */
export function fixtureTotal(c: number[], affinity: number): number {
  const base = Math.round(CRITERIA.reduce((sum, k, i) => sum + (c[i] ?? 0) * RUBRIC.weights[k], 0) / 5);
  return Math.min(100, Math.max(0, base + affinity));
}

export function fixtureBand(total: number): Band {
  return total >= RUBRIC.bands.green_min ? 'green' : total >= RUBRIC.bands.yellow_min ? 'yellow' : 'red';
}

const decisionFor = (r: RoleSeed, band: Band): ScoreDecision =>
  r.status === 'held'
    ? 'held'
    : r.status === 'archived' && (r.reason === 'below_threshold' || r.reason === 'dealbreaker')
      ? 'archived'
      : band === 'green'
        ? 'active'
        : 'archived';

let scoreN = 0;
export const scores: Score[] = ROLE_SEEDS.flatMap((r, i) => {
  if (!r.c) return [];
  const role = roles[i] as Role;
  const co = companyById.get(r.co) as Company;
  const c = [...r.c].map(Number);
  const mk = (cs: number[], versionId: string, created: string): Score => {
    const affinity_mod = Math.max(-5, Math.min(5, co.affinity));
    const total = fixtureTotal(cs, affinity_mod);
    const band = fixtureBand(total);
    const crit = Object.fromEntries(CRITERIA.map((k, j) => [k, cs[j] as number])) as Record<(typeof CRITERIA)[number], number>;
    return {
      id: `sc_${pad(++scoreN)}`,
      role_id: role.id,
      profile_version_id: versionId,
      rubric_json: { ...RUBRIC, profile_version_id: versionId },
      c1: crit.c1,
      c2: crit.c2,
      c3: crit.c3,
      c4: crit.c4,
      c5: crit.c5,
      c6: crit.c6,
      c7: crit.c7,
      c8: crit.c8,
      c9: crit.c9,
      affinity_mod,
      total,
      band,
      decision: decisionFor(r, band),
      facts_json: { workplace: r.wp, dealbreaker_hit: r.reason === 'dealbreaker' ? 'ad tech' : null },
      created_at: created,
    };
  };
  const out = [mk(c, 'pv_0002', at(r.found, 9))];
  // Rescore history on the first active role: an older score under pv_0001.
  if (i === 3)
    out.unshift(
      mk(
        c.map((v) => Math.max(1, v - 1)),
        'pv_0001',
        at(r.found + 1, 9),
      ),
    );
  return out;
});

// ------------------------------------------------------- applications etc.

const roleId = (co: string, title: string) => `${co}_${slug(title)}`;
const R = {
  stripeOnDeck: roleId('stripe', 'Staff PM, Data Platform'),
  linearDraft: roleId('linear', 'Product Lead, Insights'),
  vercelDraft: roleId('vercel', 'Principal PM, Data'),
  stripeApplied: roleId('stripe', 'Principal PM, Revenue Data'),
  notionApplied: roleId('notion', 'Staff PM, AI Connectors'),
  dbxApplied: roleId('databricks', 'Principal PM, Unity Catalog'),
  figmaIv: roleId('figma', 'Staff PM, Data Platform'),
  rampIv: roleId('ramp', 'Principal PM, AI Agents'),
  retoolOffer: roleId('retool', 'Head of Data Product'),
  datadogActive: roleId('datadog', 'Group PM, Cloud Cost'),
  vercelClosed: roleId('vercel', 'Staff PM, Edge Network'),
  airtableOnDeck: roleId('airtable', 'Principal PM, AI Platform'),
  notionInbox: roleId('notion', 'Product Lead, Data Platform'),
} as const;
export const FIXTURE_ROLE_IDS = R;

const pkg = (id: string, withAnswers = false) => ({
  resume: vaultPath.application(id, 'resume'),
  cover_letter: vaultPath.application(id, 'cover_letter'),
  fit_map: vaultPath.application(id, 'fit_map'),
  ...(withAnswers ? { answers: vaultPath.application(id, 'answers') } : {}),
});

export const applications: Application[] = [
  { id: 'ap_0001', role_id: R.stripeOnDeck, stage: 'research', applied_at: null, portal_url: null, package_paths_json: {} },
  { id: 'ap_0002', role_id: R.linearDraft, stage: 'connect', applied_at: null, portal_url: null, package_paths_json: pkg(R.linearDraft) },
  {
    id: 'ap_0003',
    role_id: R.vercelDraft,
    stage: 'submit',
    applied_at: null,
    portal_url: 'https://boards.greenhouse.io/vercel',
    package_paths_json: pkg(R.vercelDraft, true),
  },
  {
    id: 'ap_0004',
    role_id: R.stripeApplied,
    stage: 'done',
    applied_at: at(20),
    portal_url: null,
    package_paths_json: pkg(R.stripeApplied, true),
  },
  {
    id: 'ap_0005',
    role_id: R.notionApplied,
    stage: 'done',
    applied_at: at(18),
    portal_url: null,
    package_paths_json: pkg(R.notionApplied, true),
  },
  { id: 'ap_0006', role_id: R.dbxApplied, stage: 'done', applied_at: at(24), portal_url: null, package_paths_json: pkg(R.dbxApplied) },
  { id: 'ap_0007', role_id: R.figmaIv, stage: 'done', applied_at: at(30), portal_url: null, package_paths_json: pkg(R.figmaIv, true) },
  { id: 'ap_0008', role_id: R.rampIv, stage: 'done', applied_at: at(28), portal_url: null, package_paths_json: pkg(R.rampIv) },
  {
    id: 'ap_0009',
    role_id: R.retoolOffer,
    stage: 'done',
    applied_at: at(40),
    portal_url: null,
    package_paths_json: pkg(R.retoolOffer, true),
  },
];

export const interviews: Interview[] = [
  {
    id: 'iv_0001',
    role_id: R.figmaIv,
    round: 1,
    at: at(10, 15),
    prep_path: vaultPath.interviewPrep(R.figmaIv),
    retro_path: vaultPath.interviewRetro(R.figmaIv, 1),
    outcome: 'advanced',
  },
  {
    id: 'iv_0002',
    role_id: R.figmaIv,
    round: 2,
    at: at(-2, 16),
    prep_path: vaultPath.interviewPrep(R.figmaIv),
    retro_path: null,
    outcome: 'pending',
  },
  { id: 'iv_0003', role_id: R.rampIv, round: 1, at: at(-4, 14), prep_path: null, retro_path: null, outcome: 'pending' },
  { id: 'iv_0004', role_id: R.retoolOffer, round: 3, at: at(12, 15), prep_path: null, retro_path: null, outcome: 'offer' },
];

// ------------------------------------------------------------------- people

export const contacts: Contact[] = [
  {
    id: 'ct_0001',
    name: 'Maya R.',
    headline: 'Head of Product, Insights',
    linkedin_url: 'https://www.linkedin.com/in/fixture-maya-r',
    email: null,
    source: 'linkedin',
    notes: null,
    email_source: null,
    email_confidence: null,
  },
  {
    id: 'ct_0002',
    name: 'Dev P.',
    headline: 'Engineering Manager',
    linkedin_url: 'https://www.linkedin.com/in/fixture-dev-p',
    email: null,
    source: 'linkedin',
    notes: null,
    email_source: null,
    email_confidence: null,
  },
  {
    id: 'ct_0003',
    name: 'Lina K.',
    headline: 'Product Designer',
    linkedin_url: 'https://www.linkedin.com/in/fixture-lina-k',
    email: null,
    source: 'linkedin',
    notes: null,
    email_source: null,
    email_confidence: null,
  },
  {
    id: 'ct_0004',
    name: 'Omar S.',
    headline: 'Technical Recruiter',
    linkedin_url: 'https://www.linkedin.com/in/fixture-omar-s',
    email: 'omar.s@example.com',
    source: 'jd',
    notes: null,
    email_source: 'public',
    email_confidence: 0.9,
  },
  {
    id: 'ct_0005',
    name: 'Priya T.',
    headline: 'Staff Engineer',
    linkedin_url: 'https://www.linkedin.com/in/fixture-priya-t',
    email: null,
    source: 'linkedin',
    notes: null,
    email_source: null,
    email_confidence: null,
  },
  {
    id: 'ct_0006',
    name: 'Jonah W.',
    headline: 'VP Product',
    linkedin_url: 'https://www.linkedin.com/in/fixture-jonah-w',
    email: null,
    source: 'company_site',
    notes: null,
    email_source: null,
    email_confidence: null,
  },
];

export const contactLinks: ContactLink[] = [
  {
    id: 'cl_0001',
    contact_id: 'ct_0001',
    company_id: 'linear',
    role_id: R.linearDraft,
    degree: '1',
    tier: 'warm_hiring',
    via_contact_id: null,
    is_hiring_team: true,
    path: null,
    via_tie_json: null,
  },
  {
    id: 'cl_0002',
    contact_id: 'ct_0002',
    company_id: 'linear',
    role_id: R.linearDraft,
    degree: '1',
    tier: 'warm_other',
    via_contact_id: null,
    is_hiring_team: false,
    path: null,
    via_tie_json: null,
  },
  {
    id: 'cl_0003',
    contact_id: 'ct_0003',
    company_id: 'linear',
    role_id: R.linearDraft,
    degree: '2',
    tier: 'bridge',
    via_contact_id: 'ct_0002',
    is_hiring_team: false,
    path: null,
    via_tie_json: null,
  },
  {
    id: 'cl_0004',
    contact_id: 'ct_0004',
    company_id: 'linear',
    role_id: R.linearDraft,
    degree: 'cold',
    tier: 'cold_hiring',
    via_contact_id: null,
    is_hiring_team: true,
    path: null,
    via_tie_json: null,
  },
  {
    id: 'cl_0005',
    contact_id: 'ct_0005',
    company_id: 'linear',
    role_id: R.linearDraft,
    degree: 'cold',
    tier: 'cold_other',
    via_contact_id: null,
    is_hiring_team: false,
    path: null,
    via_tie_json: null,
  },
  {
    id: 'cl_0006',
    contact_id: 'ct_0006',
    company_id: 'vercel',
    role_id: R.vercelDraft,
    degree: 'cold',
    tier: 'cold_hiring',
    via_contact_id: null,
    is_hiring_team: true,
    path: null,
    via_tie_json: null,
  },
];

export const outreach: Outreach[] = [
  {
    id: 'or_0001',
    contact_id: 'ct_0001',
    role_id: R.linearDraft,
    tier: 'warm_hiring',
    gmail_draft_id: null,
    status: 'drafted',
    md_path: vaultPath.outreach('ct_0001', R.linearDraft),
    about_contact_id: null,
    gmail_to: null,
  },
  {
    id: 'or_0002',
    // #98: a bridge intro is filed under the mutual (Dev P.), about the target (Lina K.).
    contact_id: 'ct_0002',
    role_id: R.linearDraft,
    tier: 'bridge',
    gmail_draft_id: 'fixture-draft-0002',
    status: 'in_gmail',
    md_path: vaultPath.outreach('ct_0002', R.linearDraft, 'ct_0003'),
    about_contact_id: 'ct_0003',
    gmail_to: null,
  },
  {
    id: 'or_0003',
    contact_id: 'ct_0006',
    role_id: R.vercelDraft,
    tier: 'cold_hiring',
    gmail_draft_id: 'fixture-draft-0003',
    status: 'replied',
    md_path: vaultPath.outreach('ct_0006', R.vercelDraft),
    about_contact_id: null,
    gmail_to: null,
  },
];

// ---------------------------------------------------------------- decisions

const dec = (
  d: Partial<Decision> &
    Pick<
      Decision,
      'id' | 'kind' | 'subject_type' | 'subject_id' | 'question_json' | 'answer_json' | 'p' | 'impact' | 'policy_outcome' | 'status'
    >,
): Decision => ({
  ts: at(0, 6),
  backend: 'kev',
  human_choice: null,
  overridden: false,
  undo_until: null,
  resolved_at: null,
  latency_ms: 140,
  action_json: null,
  ...d,
});

export const decisions: Decision[] = [
  // Needs you: one pending per variant in the design
  dec({
    id: 'dc_0001',
    kind: 'freshness.closed',
    subject_type: 'role',
    subject_id: R.datadogActive,
    question_json: { id: 'open', type: 'noulli', instructions: 'Is this posting still accepting applications?' },
    answer_json: { id: 'open', value: true, p: 0.62 },
    p: 0.62,
    impact: 'medium',
    policy_outcome: 'human',
    status: 'pending',
    // Archive only when the final answer is "not open"; undo restores the previous status.
    action_json: {
      op: 'roles.archive',
      input: { role_id: R.datadogActive, reason: 'closed' },
      when: false,
      undo: { op: 'roles.move', input: { role_id: R.datadogActive, to: 'active' } },
    },
  }),
  dec({
    id: 'dc_0002',
    kind: 'inbox.classify',
    subject_type: 'role',
    subject_id: R.notionApplied,
    question_json: {
      id: 'class',
      type: 'choice',
      instructions: 'What is this email?',
      options: ['confirmation', 'interview_request', 'offer', 'rejection', 'outreach_reply', 'other'],
    },
    answer_json: { id: 'class', value: 'interview_request', p: 0.78 },
    p: 0.78,
    impact: 'medium',
    policy_outcome: 'human',
    status: 'pending',
    action_json: {
      op: 'inbox.ingest',
      input: {
        messages: [{ message_id: 'fixture-msg-1', received_at: at(0, 5), role_id: R.notionApplied, class: 'interview_request', p: 0.78 }],
      },
    },
  }),
  dec({
    id: 'dc_0003',
    kind: 'profile.apply_diff',
    subject_type: 'profile_diff',
    subject_id: 'pd_0001',
    question_json: { id: 'apply', type: 'noulli', instructions: 'Raise the comp floor to 215k?' },
    answer_json: { id: 'apply', value: true, p: 0.91 },
    p: 0.91,
    impact: 'high',
    policy_outcome: 'human',
    status: 'pending',
    backend: 'agent',
    action_json: { op: 'profile.apply_diff', input: { diff_id: 'pd_0001' } },
  }),
  dec({
    id: 'dc_0004',
    kind: 'outreach.to_gmail',
    subject_type: 'outreach',
    subject_id: 'or_0001',
    question_json: { id: 'ready', type: 'noulli', instructions: 'Is this draft ready for Gmail?' },
    answer_json: { id: 'ready', value: true, p: 0.86 },
    p: 0.86,
    impact: 'medium',
    policy_outcome: 'human',
    status: 'pending',
    action_json: { op: 'outreach.to_gmail', input: { outreach_id: 'or_0001' } },
  }),
  dec({
    id: 'dc_0005',
    kind: 'apply.submit',
    subject_type: 'role',
    subject_id: R.vercelDraft,
    question_json: { id: 'submit', type: 'noulli', instructions: 'Ready to submit?' },
    answer_json: { id: 'submit', value: true, p: 0.94 },
    p: 0.94,
    impact: 'high',
    policy_outcome: 'human',
    status: 'pending',
    action_json: { op: 'apply.mark_submitted', input: { role_id: R.vercelDraft } },
  }),
  dec({
    id: 'dc_0006',
    kind: 'people.classify',
    subject_type: 'contact',
    subject_id: 'ct_0005',
    question_json: {
      id: 'who',
      type: 'choice',
      instructions: 'Who is this person for the role?',
      options: ['hiring_manager', 'hiring_team', 'recruiter', 'peer', 'unrelated', 'other'],
    },
    answer_json: { id: 'who', value: 'peer', p: 0.55 },
    p: 0.55,
    // Medium: under the Wave 2 grid low impact never routes to a human.
    impact: 'medium',
    policy_outcome: 'human',
    status: 'pending',
  }),
  dec({
    id: 'dc_0007',
    kind: 'roles.dedupe',
    subject_type: 'role',
    subject_id: R.notionInbox,
    question_json: { id: 'same', type: 'noulli', instructions: 'Same job as an existing role?' },
    answer_json: { id: 'same', value: false, p: 0.64 },
    p: 0.64,
    impact: 'low',
    // Near matches are always queued for a human (lane B: forceHuman).
    policy_outcome: 'human',
    status: 'pending',
    backend: 'rule',
  }),
  // Auto stream (last 24h)
  dec({
    id: 'dc_0101',
    kind: 'freshness.closed',
    subject_type: 'role',
    subject_id: R.vercelClosed,
    ts: at(0, 6),
    question_json: { id: 'open', type: 'noulli', instructions: 'Is this posting still accepting applications?' },
    answer_json: { id: 'open', value: false, p: 0.97 },
    p: 0.97,
    impact: 'medium',
    // Pre-#24 grid row kept as the undoable auto example (the #24 grid gives medium + confident plain auto).
    policy_outcome: 'auto_undo',
    status: 'applied',
    undo_until: at(-1, 6),
    resolved_at: at(0, 6),
    action_json: {
      op: 'roles.archive',
      input: { role_id: R.vercelClosed, reason: 'closed' },
      when: false,
      undo: { op: 'roles.move', input: { role_id: R.vercelClosed, to: 'active' } },
    },
  }),
  dec({
    id: 'dc_0102',
    kind: 'roles.criterion',
    subject_type: 'role',
    subject_id: R.airtableOnDeck,
    ts: at(0, 5),
    question_json: { id: 'c4', type: 'score', instructions: 'Data fundamentals in this role', min: 1, max: 5 },
    answer_json: { id: 'c4', value: 5, p: 0.93 },
    p: 0.93,
    impact: 'low',
    policy_outcome: 'auto',
    status: 'applied',
    resolved_at: at(0, 5),
  }),
  dec({
    id: 'dc_0103',
    kind: 'people.classify',
    subject_type: 'contact',
    subject_id: 'ct_0001',
    ts: at(0, 4),
    question_json: {
      id: 'who',
      type: 'choice',
      instructions: 'Who is this person for the role?',
      options: ['hiring_manager', 'hiring_team', 'recruiter', 'peer', 'unrelated', 'other'],
    },
    answer_json: { id: 'who', value: 'hiring_manager', p: 0.81, second: { backend: 'agent', value: 'hiring_manager', p: 0.77 } },
    p: 0.81,
    impact: 'medium',
    policy_outcome: 'auto_second',
    status: 'applied',
    resolved_at: at(0, 4),
  }),
];

// ------------------------------------------------------------- events, runs

let evN = 0;
const ev = (e: Omit<EventRow, 'id'>): EventRow => ({ id: `ev_${pad(++evN)}`, ...e });

export const events: EventRow[] = [
  ...roles.map((r) =>
    ev({
      ts: r.found_at,
      type: 'role_added',
      subject_type: 'role',
      subject_id: r.id,
      payload_json: { source: r.source },
      actor: 'schedule',
      decision_id: null,
    }),
  ),
  ...scores.map((s) =>
    ev({
      ts: s.created_at,
      type: 'role_scored',
      subject_type: 'role',
      subject_id: s.role_id,
      payload_json: { score_id: s.id, total: s.total, band: s.band },
      actor: 'agent',
      decision_id: null,
    }),
  ),
  ev({
    ts: at(5, 9),
    type: 'role_held',
    subject_type: 'role',
    subject_id: roleId('datadog', 'Senior PM, Synthetic Monitoring'),
    payload_json: { reason: 'company_cap' },
    actor: 'agent',
    decision_id: null,
  }),
  ev({
    ts: at(7, 10),
    type: 'role_picked',
    subject_type: 'role',
    subject_id: R.stripeOnDeck,
    payload_json: { from: 'active', to: 'on-deck' },
    actor: 'human',
    decision_id: null,
  }),
  ev({
    ts: at(14, 11),
    type: 'application_tailored',
    subject_type: 'role',
    subject_id: R.linearDraft,
    payload_json: {},
    actor: 'agent',
    decision_id: null,
  }),
  ev({
    ts: at(20, 12),
    type: 'application_submitted',
    subject_type: 'role',
    subject_id: R.stripeApplied,
    payload_json: {},
    actor: 'human',
    decision_id: null,
  }),
  ev({
    ts: at(12, 15),
    type: 'offer',
    subject_type: 'role',
    subject_id: R.retoolOffer,
    payload_json: {},
    actor: 'agent',
    decision_id: null,
  }),
  ev({
    ts: at(10, 18),
    type: 'interview_retro',
    subject_type: 'interview',
    subject_id: 'iv_0001',
    payload_json: {},
    actor: 'human',
    decision_id: null,
  }),
  ev({
    ts: at(0, 6),
    type: 'role_closed',
    subject_type: 'role',
    subject_id: R.vercelClosed,
    payload_json: { method: 'ats_api' },
    actor: 'schedule',
    decision_id: 'dc_0101',
  }),
  ev({
    ts: at(0, 6),
    type: 'role_archived',
    subject_type: 'role',
    subject_id: R.vercelClosed,
    payload_json: { reason: 'closed' },
    actor: 'schedule',
    decision_id: 'dc_0101',
  }),
  ev({
    ts: at(1, 7),
    type: 'profile_diff_proposed',
    subject_type: 'profile_diff',
    subject_id: 'pd_0001',
    payload_json: { component: 'terms' },
    actor: 'agent',
    decision_id: null,
  }),
  ev({
    ts: at(0, 6),
    type: 'profile_diff_proposed',
    subject_type: 'profile_diff',
    subject_id: 'pd_0002',
    payload_json: { component: 'domain' },
    actor: 'agent',
    decision_id: null,
  }),
  ev({
    ts: at(2, 9),
    type: 'outreach_replied',
    subject_type: 'outreach',
    subject_id: 'or_0003',
    payload_json: {},
    actor: 'schedule',
    decision_id: null,
  }),
];

// Link diffs to the events that proposed them.
for (const d of profileDiffs) d.event_id = events.find((e) => e.type === 'profile_diff_proposed' && e.subject_id === d.id)?.id ?? null;

export const runs: Run[] = [
  {
    id: 'rn_0001',
    op: 'scout',
    started_at: at(6, 5),
    finished_at: at(6, 6),
    status: 'ok',
    summary_json: { queries: 24, found: 11, added: 7, duplicates: 4 },
    log_path: vaultPath.runLog('2026-10-02', 'scout'),
  },
  {
    id: 'rn_0002',
    op: 'freshness',
    started_at: at(0, 6),
    finished_at: at(0, 6),
    status: 'ok',
    summary_json: { checked: 16, open: 13, closed: 1, unsure: 2 },
    log_path: vaultPath.runLog('2026-10-08', 'freshness'),
  },
  { id: 'rn_0003', op: 'inbox', started_at: at(0, 7), finished_at: null, status: 'running', summary_json: {}, log_path: null },
];

// ---------------------------------------------------------- onboarding

/** A re-interview of two components, paused at calibration. */
export const onboardSessions: OnboardSession[] = [
  {
    id: 'ob_0001',
    started_at: at(1, 20),
    updated_at: at(1, 21),
    step: 'calibrate',
    scope_json: ['domain', 'growth'],
    draft_json: {
      domain: { ranked: ['AI tooling', 'data infrastructure', 'developer platforms'] },
      growth: { scope_ceiling: 'VP product', trajectory: 'up' },
    },
    sources_json: { domain: ['profile', 'interview'], growth: ['profile', 'interview'] },
    answered_json: ['domain.ranked', 'growth.scope_ceiling'],
    calibration_json: { sample_ids: ['cal_01', 'cal_02', 'cal_03'], choices: { cal_01: 'yes' } },
    version_id: null,
    interview_json: {},
  },
];

/** One earlier Ask thread (#69): a Claude Code session with two turns. */
export const askThreads: AskThreadRow[] = [
  {
    id: 'ask_01jz0000000000000000000001',
    created_at: at(1, 18),
    updated_at: at(1, 18),
    runner: 'claude',
    session_id: 'sess-fixture-0001',
    turns_json: [
      { user: 'Which active roles are going stale?', reply: 'root = Reply([t])\nt = Text("Two active roles look stale")' },
      { user: 'Score my inbox roles', reply: 'root = Reply([t])\nt = Text("Score run started for your inbox")' },
    ],
  },
];

/** Insert order respects foreign keys. */
export const FIXTURE_TABLES = {
  profile_version: profileVersions,
  profile_component: profileComponents,
  profile_diff: profileDiffs,
  company: companies,
  role: roles,
  score: scores,
  event: events,
  application: applications,
  contact: contacts,
  contact_link: contactLinks,
  outreach,
  interview: interviews,
  decision: decisions,
  run: runs,
  onboard_session: onboardSessions,
  ask_thread: askThreads,
} as const;

/** An established search: the Getting started path (#24) is long finished. */
export const FIXTURE_CONFIG: typeof DEFAULT_CONFIG = { ...DEFAULT_CONFIG, ui: { guide: { policy: true, review: true, done: true } } };
