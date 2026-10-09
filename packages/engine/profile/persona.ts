/*
 * Personas (#74): the interview's persona-dependent options (Craft functions, levels, typical titles,
 * Domain, Growth scope) and the scout's title variations follow who the resume says the user is, not a
 * fixed product-manager list. The onboard agent run generates the options from the resume
 * (`onboard.extract { options }`); this table is the instant preview and the fallback. Pure.
 */

export const OPTION_KEYS = ['functions', 'levels', 'titles', 'domains', 'scopes'] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];

/** Options kept with the onboarding session (`interview_json.options`). */
export type PersonaOptions = { persona: string | null; by: 'preview' | 'agent' } & Partial<Record<OptionKey, string[]>>;

export interface Persona {
  id: string;
  /** Title words that point at the persona. */
  match: RegExp;
  functions: string[];
  levels: string[];
  domains: string[];
  /** Growth scope ceilings, in order. */
  scopes: string[];
  /** The scope one step above a Craft level. */
  next: Record<string, string>;
}

/** Typical titles per Craft function (unlevelled; the scout adds the level). */
export const FUNCTION_TITLES: Record<string, string[]> = {
  PM: ['Product Manager', 'Group Product Manager', 'Director of Product', 'Head of Product'],
  TPM: ['Technical Program Manager'],
  FDE: ['Forward Deployed Engineer'],
  'Data Science': ['Data Scientist', 'Machine Learning Scientist'],
  Engineering: ['Software Engineer', 'Engineering Manager'],
  'Engineering Management': ['Engineering Manager', 'Director of Engineering'],
  'Data Engineering': ['Data Engineer'],
  'ML Engineering': ['Machine Learning Engineer'],
  Analytics: ['Data Analyst', 'Analytics Manager'],
  Sales: ['Account Executive', 'Enterprise Account Executive', 'Sales Manager', 'Director of Sales'],
  'Account Management': ['Account Manager', 'Strategic Account Manager'],
  'Business Development': ['Business Development Manager', 'Partnerships Manager'],
  'Sales Engineering': ['Sales Engineer', 'Solutions Engineer'],
  'Sales Leadership': ['Sales Director', 'VP of Sales'],
  Marketing: ['Marketing Manager', 'Product Marketing Manager', 'Head of Marketing'],
  'Product Marketing': ['Product Marketing Manager'],
  'Growth Marketing': ['Growth Marketing Manager'],
  Design: ['Product Designer', 'Design Lead'],
  Research: ['UX Researcher'],
  'Customer Success': ['Customer Success Manager', 'Head of Customer Success'],
  Support: ['Support Manager'],
  Solutions: ['Solutions Consultant', 'Implementation Manager'],
};

const PRODUCT_NEXT: Record<string, string> = {
  senior: 'principal IC',
  staff: 'principal IC',
  principal: 'group PM',
  group: 'head of product',
  head: 'VP product',
  director: 'VP product',
  vp: 'founder',
};

export const PERSONAS: Persona[] = [
  {
    id: 'product',
    match:
      /product manag|\bPM\b|product lead|head of product|product leader|chief product|\bCPO\b|product owner|technical program|\bTPM\b|forward[- ]deployed|\bFDE\b/i,
    functions: ['PM', 'TPM', 'FDE', 'Data Science', 'Engineering'],
    levels: ['senior', 'staff', 'principal', 'group', 'head', 'director', 'vp'],
    domains: ['AI infra', 'developer tools', 'data platforms', 'frontier AI', 'fintech', 'healthcare', 'security'],
    scopes: ['principal IC', 'group PM', 'head of product', 'VP product', 'founder'],
    next: PRODUCT_NEXT,
  },
  {
    id: 'sales',
    match: /account executive|\bAE\b|\bsales\b|business development|\bBDR\b|\bSDR\b|account manag|partnerships|\bCRO\b|revenue/i,
    functions: ['Sales', 'Account Management', 'Business Development', 'Sales Engineering', 'Sales Leadership'],
    levels: ['associate', 'senior', 'mid-market', 'enterprise', 'strategic', 'manager', 'director', 'vp'],
    domains: ['SaaS', 'enterprise software', 'fintech', 'healthcare', 'security', 'developer tools', 'AI'],
    scopes: ['senior AE', 'sales manager', 'director of sales', 'VP sales', 'CRO', 'founder'],
    next: {
      associate: 'senior AE',
      senior: 'sales manager',
      'mid-market': 'senior AE',
      enterprise: 'sales manager',
      strategic: 'sales manager',
      lead: 'sales manager',
      manager: 'director of sales',
      director: 'VP sales',
      head: 'VP sales',
      vp: 'CRO',
    },
  },
  {
    id: 'marketing',
    match: /marketing|marketer|brand|demand gen|content strateg|\bCMO\b/i,
    functions: ['Marketing', 'Product Marketing', 'Growth Marketing'],
    levels: ['senior', 'lead', 'manager', 'director', 'head', 'vp'],
    domains: ['SaaS', 'consumer', 'fintech', 'healthcare', 'developer tools', 'AI'],
    scopes: ['senior IC', 'marketing manager', 'director of marketing', 'VP marketing', 'CMO', 'founder'],
    next: {
      senior: 'marketing manager',
      lead: 'marketing manager',
      manager: 'director of marketing',
      director: 'VP marketing',
      head: 'VP marketing',
      vp: 'CMO',
    },
  },
  {
    id: 'design',
    match: /designer|\bdesign\b|\bUX\b|user research/i,
    functions: ['Design', 'Research'],
    levels: ['senior', 'staff', 'principal', 'lead', 'manager', 'director', 'head'],
    domains: ['consumer', 'SaaS', 'developer tools', 'fintech', 'healthcare', 'AI'],
    scopes: ['principal IC', 'design manager', 'head of design', 'VP design', 'founder'],
    next: {
      senior: 'principal IC',
      staff: 'principal IC',
      principal: 'design manager',
      lead: 'design manager',
      manager: 'head of design',
      director: 'VP design',
      head: 'VP design',
    },
  },
  {
    id: 'customer_success',
    match: /customer success|customer experience|\bsupport\b|implementation|onboarding manag|solutions consult/i,
    functions: ['Customer Success', 'Support', 'Solutions', 'Account Management'],
    levels: ['associate', 'senior', 'lead', 'manager', 'director', 'head', 'vp'],
    domains: ['SaaS', 'enterprise software', 'fintech', 'healthcare', 'developer tools', 'AI'],
    scopes: ['senior IC', 'customer success manager', 'director of customer success', 'VP customer success', 'founder'],
    next: {
      associate: 'senior IC',
      senior: 'customer success manager',
      lead: 'customer success manager',
      manager: 'director of customer success',
      director: 'VP customer success',
      head: 'VP customer success',
    },
  },
  {
    id: 'data',
    match: /data scien|data analy|analytics|machine learning scien|\bML scien|statistic/i,
    functions: ['Data Science', 'Analytics', 'ML Engineering', 'Data Engineering'],
    levels: ['senior', 'staff', 'principal', 'lead', 'manager', 'director', 'head'],
    domains: ['data platforms', 'AI infra', 'frontier AI', 'fintech', 'healthcare', 'consumer'],
    scopes: ['principal IC', 'data science manager', 'head of data', 'VP data', 'founder'],
    next: {
      senior: 'principal IC',
      staff: 'principal IC',
      principal: 'data science manager',
      lead: 'data science manager',
      manager: 'head of data',
      director: 'VP data',
      head: 'VP data',
    },
  },
  {
    id: 'engineering',
    match: /engineer|developer|\bSWE\b|\bSRE\b|architect|\bCTO\b/i,
    functions: ['Engineering', 'Engineering Management', 'Data Engineering', 'ML Engineering', 'FDE'],
    levels: ['senior', 'staff', 'principal', 'lead', 'manager', 'director', 'vp'],
    domains: ['developer tools', 'AI infra', 'data platforms', 'healthcare', 'fintech', 'security', 'consumer'],
    scopes: ['principal IC', 'engineering manager', 'director of engineering', 'VP engineering', 'CTO', 'founder'],
    next: {
      senior: 'principal IC',
      staff: 'principal IC',
      principal: 'principal IC',
      lead: 'engineering manager',
      manager: 'director of engineering',
      director: 'VP engineering',
      head: 'VP engineering',
      vp: 'CTO',
    },
  },
];

/** The static fallback (no persona recognized): the original lists. */
export const FALLBACK_OPTIONS: Record<OptionKey, string[]> = {
  functions: ['PM', 'TPM', 'FDE', 'Data Science', 'Engineering'],
  levels: ['senior', 'staff', 'principal', 'group', 'head', 'director', 'vp'],
  titles: ['Product Manager', 'Technical Program Manager', 'Forward Deployed Engineer', 'Data Scientist', 'Software Engineer'],
  domains: ['AI infra', 'developer tools', 'data platforms', 'frontier AI', 'fintech', 'healthcare', 'security'],
  scopes: ['principal IC', 'group PM', 'head of product', 'VP product', 'founder'],
};

const norm = (s: string) => s.trim().toLowerCase();

/** Case-insensitive union, first spelling kept, in order. */
export function uniq(xs: readonly string[], max = Number.POSITIVE_INFINITY): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = x.trim();
    if (!t || seen.has(norm(t))) continue;
    seen.add(norm(t));
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** The persona a set of titles (headline, role titles) points at: most matching titles wins; null when none. */
export function detectPersona(titles: readonly string[]): Persona | null {
  let best: Persona | null = null;
  let bestN = 0;
  for (const p of PERSONAS) {
    const n = titles.filter((t) => p.match.test(t)).length;
    if (n > bestN) {
      best = p;
      bestN = n;
    }
  }
  return best;
}

/** The persona a Craft function belongs to (by name, else by its words). */
export function personaForFunction(fn: string): Persona | null {
  return PERSONAS.find((p) => p.functions.some((f) => norm(f) === norm(fn))) ?? PERSONAS.find((p) => p.match.test(fn)) ?? null;
}

/** A title without its specialty ("Principal Product Manager, Analytics" -> "Principal Product Manager"). */
export const coreTitle = (t: string): string =>
  t
    .split(/,|\s[-|/]\s|\(/)[0]
    ?.replace(/\s+/g, ' ')
    .trim() ?? '';

/** Typical titles for Craft functions (a function with none known is used as written). */
export const titlesForFunctions = (fns: readonly string[]): string[] => uniq(fns.flatMap((f) => FUNCTION_TITLES[f] ?? [f]));

/** The persona of a Craft draft (re-interview: no resume plan), from its functions and titles. */
export function personaOfCraft(craft: Record<string, unknown> | undefined): Persona | null {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
  const fns = list(craft?.functions);
  for (const f of fns) {
    const p = personaForFunction(f);
    if (p) return p;
  }
  return detectPersona(list(craft?.titles));
}

/**
 * The instant preview's options from the resume: the persona's lists with what the resume shows first
 * (its functions, its titles, its domains). No persona: the static fallback, plus the resume's titles.
 */
export function previewOptions(input: {
  titles: readonly string[];
  /** Titles the persona is detected from (default `titles`): the headline too. */
  personaTitles?: readonly string[];
  functions: readonly string[];
  domains: readonly string[];
}): PersonaOptions {
  const p = detectPersona(input.personaTitles ?? input.titles);
  const base = p ?? {
    functions: FALLBACK_OPTIONS.functions,
    levels: FALLBACK_OPTIONS.levels,
    domains: FALLBACK_OPTIONS.domains,
    scopes: FALLBACK_OPTIONS.scopes,
  };
  const typical = (p ? p.functions : input.functions).flatMap((f) => FUNCTION_TITLES[f] ?? []);
  return {
    persona: p?.id ?? null,
    by: 'preview',
    functions: uniq([...input.functions, ...base.functions], 12),
    levels: [...base.levels],
    titles: uniq([...input.titles.map(coreTitle), ...typical], 10),
    domains: uniq([...input.domains, ...base.domains], 10),
    scopes: [...base.scopes],
  };
}

const IC_LEVELS = ['senior', 'staff', 'principal', 'lead', 'enterprise', 'strategic', 'mid-market'];
const LEVELLED =
  /\b(senior|sr\.?|staff|principal|lead|group|head|director|vp|vice president|chief|enterprise|strategic|mid-market|associate|junior)\b/i;
const cap = (s: string) => s.replace(/(^|[\s-])([a-z])/g, (_m, a: string, b: string) => a + b.toUpperCase());

/**
 * Scout title variations (#74): Craft `titles` first (as written, specialty dropped), then each Craft
 * function's typical titles at the Craft level (an IC level is prefixed to an unlevelled title), then the
 * plain title (one level around). A function with no known titles is used as written. Persona-aware: a
 * sales profile yields sales titles, never product ones.
 */
export function titleVariations(craft: Record<string, unknown> | undefined, max = 12): string[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? [v] : []);
  const level = typeof craft?.level === 'string' ? craft.level.trim().toLowerCase() : '';
  const prefix = IC_LEVELS.includes(level) ? cap(level) : '';
  const own = list(craft?.titles).map(coreTitle);
  const typical = [...list(craft?.functions), ...list(craft?.target)].flatMap((f) => FUNCTION_TITLES[f] ?? FUNCTION_TITLES[cap(f)] ?? [f]);
  const levelled = typical.map((t) => (prefix && !LEVELLED.test(t) ? `${prefix} ${t}` : t));
  const plain = typical.filter((t) => prefix && !LEVELLED.test(t));
  return uniq([...own, ...levelled, ...plain], max);
}
