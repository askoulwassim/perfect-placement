import { type ProfileComponentKey, VOICE_SAMPLE_MAX_CHARS, VOICE_SAMPLES_MAX } from '@perfect-placement/contracts';

/*
 * Onboarding question bank: two to four adaptive questions per component, chips or
 * sliders over free text. Labels are one to three words (UI copy rule).
 *
 * Skip logic: a question is skipped when `known(draft)` is true, i.e. the resume (or
 * an earlier answer, or the current profile) already answered it. "Never ask what the
 * resume answers." A scoped re-interview of one component ignores `known` so the
 * questions are asked again.
 */

export type Draft = Partial<Record<ProfileComponentKey, Record<string, unknown>>>;
export type AnswerType = 'chips' | 'multi_chips' | 'slider' | 'text';
export type AnswerValue = string | number | string[];

export interface QuestionDef {
  id: string;
  component: ProfileComponentKey;
  label: string;
  answer_type: AnswerType;
  options?: string[];
  min?: number;
  max?: number;
  /** List text question: a string answer appends one item, a string[] answer replaces the list. */
  max_items?: number;
  max_chars?: number;
  /** The list kept so far (list questions). */
  items?: (d: Draft) => string[];
  /** Already answered by the draft (resume, earlier answer, current profile). */
  known: (d: Draft) => boolean;
  /** Only ask when this holds (adaptive follow-ups). */
  when?: (d: Draft) => boolean;
  apply: (d: Draft, v: AnswerValue) => void;
}

const comp = (d: Draft, k: ProfileComponentKey) => {
  d[k] ??= {};
  return d[k] as Record<string, unknown>;
};
const has = (d: Draft, k: ProfileComponentKey, f: string) => {
  const v = d[k]?.[f];
  if (v == null || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
};
export const asList = (v: AnswerValue): string[] =>
  (Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean);
const asNum = (v: AnswerValue): number => {
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`not a number: ${String(v)}`);
  return n;
};
const asStr = (v: AnswerValue): string => (Array.isArray(v) ? v.join(', ') : String(v)).trim();
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const set =
  (k: ProfileComponentKey, f: string, conv: (v: AnswerValue) => unknown = asStr) =>
  (d: Draft, v: AnswerValue) => {
    comp(d, k)[f] = conv(v);
  };
const known = (k: ProfileComponentKey, f: string) => (d: Draft) => has(d, k, f);

const voiceSamplesOf = (d: Draft): string[] =>
  Array.isArray(d.voice?.samples) ? (d.voice.samples as unknown[]).filter((x): x is string => typeof x === 'string') : [];

/**
 * Voice samples after an answer: a string appends one sample (a duplicate is ignored), a string[]
 * replaces the list (so the UI can remove one). Capped at VOICE_SAMPLES_MAX of VOICE_SAMPLE_MAX_CHARS.
 */
export function nextSamples(current: readonly string[], v: AnswerValue): string[] {
  const incoming = (Array.isArray(v) ? v : [String(v)]).map((s) => String(s).trim()).filter(Boolean);
  for (const s of incoming)
    if (s.length > VOICE_SAMPLE_MAX_CHARS) throw new Error(`voice.sample: a sample is over ${VOICE_SAMPLE_MAX_CHARS} chars`);
  const list = Array.isArray(v) ? [...new Set(incoming)] : current.includes(incoming[0] ?? '') ? [...current] : [...current, ...incoming];
  if (list.length > VOICE_SAMPLES_MAX) throw new Error(`voice.sample: at most ${VOICE_SAMPLES_MAX} samples`);
  return list;
}

export const QUESTION_BANK: QuestionDef[] = [
  // Story: the resume normally answers these.
  {
    id: 'story.headline',
    component: 'story',
    label: 'Headline',
    answer_type: 'text',
    known: known('story', 'headline'),
    apply: set('story', 'headline'),
  },
  {
    id: 'story.win',
    component: 'story',
    label: 'Top win',
    answer_type: 'text',
    known: known('story', 'wins'),
    apply: (d, v) => {
      comp(d, 'story').wins = [asStr(v)];
    },
  },
  // Craft
  {
    id: 'craft.functions',
    component: 'craft',
    label: 'Function',
    answer_type: 'multi_chips',
    options: ['PM', 'TPM', 'FDE', 'Data Science', 'Engineering', 'other'],
    known: known('craft', 'functions'),
    apply: set('craft', 'functions', asList),
  },
  {
    id: 'craft.level',
    component: 'craft',
    label: 'Level',
    answer_type: 'chips',
    options: ['senior', 'staff', 'principal', 'group', 'head', 'director', 'vp', 'other'],
    known: known('craft', 'level'),
    apply: set('craft', 'level'),
  },
  {
    id: 'craft.mode',
    component: 'craft',
    label: 'IC or lead',
    answer_type: 'chips',
    options: ['ic', 'lead', 'either'],
    known: known('craft', 'mode'),
    apply: set('craft', 'mode'),
  },
  {
    id: 'craft.facing',
    component: 'craft',
    label: 'Facing',
    answer_type: 'chips',
    options: ['external', 'internal', 'either'],
    known: known('craft', 'facing'),
    apply: set('craft', 'facing'),
  },
  // Domain
  {
    id: 'domain.ranked',
    component: 'domain',
    label: 'Top domains',
    answer_type: 'multi_chips',
    options: ['AI infra', 'developer tools', 'data platforms', 'frontier AI', 'fintech', 'healthcare', 'security', 'other'],
    known: known('domain', 'ranked'),
    apply: set('domain', 'ranked', asList),
  },
  {
    id: 'domain.avoid',
    component: 'domain',
    label: 'Avoid',
    answer_type: 'multi_chips',
    options: ['ad tech', 'gambling', 'crypto', 'defense', 'none', 'other'],
    known: known('domain', 'avoid'),
    apply: (d, v) => {
      comp(d, 'domain').avoid = asList(v).filter((x) => x !== 'none');
    },
  },
  // Work mode
  {
    id: 'work_mode.modes',
    component: 'work_mode',
    label: 'Work mode',
    answer_type: 'multi_chips',
    options: ['remote', 'hybrid', 'onsite'],
    known: known('work_mode', 'modes'),
    apply: set('work_mode', 'modes', asList),
  },
  {
    id: 'work_mode.locations',
    component: 'work_mode',
    label: 'Locations',
    answer_type: 'text',
    known: known('work_mode', 'locations'),
    apply: set('work_mode', 'locations', asList),
  },
  {
    id: 'work_mode.travel',
    component: 'work_mode',
    label: 'Travel max',
    answer_type: 'slider',
    min: 0,
    max: 100,
    known: known('work_mode', 'travel_max_pct'),
    apply: set('work_mode', 'travel_max_pct', asNum),
  },
  // Terms
  {
    id: 'terms.floor',
    component: 'terms',
    label: 'Comp floor',
    answer_type: 'slider',
    min: 0,
    max: 600000,
    known: known('terms', 'comp_floor'),
    apply: set('terms', 'comp_floor', asNum),
  },
  {
    id: 'terms.target',
    component: 'terms',
    label: 'Comp target',
    answer_type: 'slider',
    min: 0,
    max: 800000,
    known: known('terms', 'comp_target'),
    apply: set('terms', 'comp_target', asNum),
  },
  {
    id: 'terms.equity',
    component: 'terms',
    label: 'Equity',
    answer_type: 'chips',
    options: ['low', 'medium', 'high'],
    known: known('terms', 'equity'),
    apply: set('terms', 'equity'),
  },
  // Company
  {
    id: 'company.stages',
    component: 'company',
    label: 'Stage',
    answer_type: 'multi_chips',
    options: ['seed', 'series-a', 'series-b', 'series-c', 'growth', 'public', 'any'],
    known: known('company', 'stages'),
    apply: set('company', 'stages', asList),
  },
  {
    id: 'company.size',
    component: 'company',
    label: 'Size',
    answer_type: 'chips',
    options: ['1-50', '50-200', '200-1000', '1000-5000', '5000+', 'any'],
    known: known('company', 'size'),
    apply: set('company', 'size'),
  },
  {
    id: 'company.dream',
    component: 'company',
    label: 'Dream companies',
    answer_type: 'text',
    known: known('company', 'dream_companies'),
    apply: (d, v) => {
      const names = asList(v);
      const c = comp(d, 'company');
      c.dream_companies = names;
      // Capped nudge (decisions.md #5): +3 default, never a dealbreaker bypass.
      c.affinity = { ...((c.affinity as Record<string, number>) ?? {}), ...Object.fromEntries(names.map((n) => [slug(n), 3])) };
    },
  },
  // Team
  {
    id: 'team.proximity',
    component: 'team',
    label: 'Decision distance',
    answer_type: 'chips',
    options: ['reports to founder or CEO', 'reports to VP or above', 'one more layer', 'other'],
    known: known('team', 'proximity'),
    apply: set('team', 'proximity'),
  },
  {
    id: 'team.size',
    component: 'team',
    label: 'Team size',
    answer_type: 'chips',
    options: ['small', 'any'],
    known: known('team', 'prefers_small_teams'),
    apply: (d, v) => {
      comp(d, 'team').prefers_small_teams = asStr(v) === 'small';
    },
  },
  // Growth
  {
    id: 'growth.ceiling',
    component: 'growth',
    label: 'Next scope',
    answer_type: 'chips',
    options: ['principal IC', 'group PM', 'head of product', 'VP product', 'founder', 'other'],
    known: known('growth', 'scope_ceiling'),
    apply: set('growth', 'scope_ceiling'),
  },
  {
    id: 'growth.trajectory',
    component: 'growth',
    label: 'Trajectory',
    answer_type: 'chips',
    options: ['up', 'broader', 'deeper', 'steady'],
    known: known('growth', 'trajectory'),
    apply: set('growth', 'trajectory'),
  },
  // Dealbreakers
  {
    id: 'dealbreakers.hard_nos',
    component: 'dealbreakers',
    label: 'Hard nos',
    answer_type: 'multi_chips',
    options: ['onsite only', 'relocation', 'below comp floor', 'deeply layered org', 'ad tech', 'gambling', 'crypto', 'defense', 'other'],
    known: known('dealbreakers', 'hard_nos'),
    apply: set('dealbreakers', 'hard_nos', asList),
  },
  {
    id: 'dealbreakers.other',
    component: 'dealbreakers',
    label: 'Other nos',
    answer_type: 'text',
    known: () => false,
    when: (d) => ((d.dealbreakers?.hard_nos as string[] | undefined) ?? []).includes('other'),
    apply: (d, v) => {
      const c = comp(d, 'dealbreakers');
      c.hard_nos = [...((c.hard_nos as string[]) ?? []).filter((x) => x !== 'other'), ...asList(v)];
    },
  },
  // Voice
  {
    id: 'voice.style',
    component: 'voice',
    label: 'Style',
    answer_type: 'chips',
    options: ['punchy', 'warm', 'formal', 'plain'],
    known: known('voice', 'style'),
    apply: set('voice', 'style'),
  },
  {
    id: 'voice.sample',
    component: 'voice',
    label: 'Writing samples',
    answer_type: 'text',
    max_items: VOICE_SAMPLES_MAX,
    max_chars: VOICE_SAMPLE_MAX_CHARS,
    items: (d) => voiceSamplesOf(d),
    known: known('voice', 'samples'),
    apply: (d, v) => {
      comp(d, 'voice').samples = nextSamples(voiceSamplesOf(d), v);
    },
  },
  // Network (LinkedIn fills this later; one optional seed question)
  {
    id: 'network.warm',
    component: 'network',
    label: 'Warm companies',
    answer_type: 'text',
    known: known('network', 'warm_companies'),
    apply: set('network', 'warm_companies', asList),
  },
];

export function findQuestion(id: string): QuestionDef | undefined {
  return QUESTION_BANK.find((q) => q.id === id);
}

/** Next question to ask, or null when the interview is complete. */
export function nextQuestion(draft: Draft, answered: readonly string[], scope?: readonly ProfileComponentKey[] | null): QuestionDef | null {
  for (const q of QUESTION_BANK) {
    if (scope && !scope.includes(q.component)) continue;
    if (answered.includes(q.id)) continue;
    if (q.when && !q.when(draft)) continue;
    if (!scope && q.known(draft)) continue;
    return q;
  }
  return null;
}

/** Validate an answer against its question's type. Throws with a short message. */
export function checkAnswer(q: QuestionDef, v: AnswerValue): void {
  if (q.answer_type === 'slider') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error(`${q.id}: expected a number`);
    if ((q.min != null && n < q.min) || (q.max != null && n > q.max)) throw new Error(`${q.id}: out of range`);
    return;
  }
  if (q.answer_type === 'chips') {
    if (Array.isArray(v) || typeof v !== 'string') throw new Error(`${q.id}: expected one option`);
    if (q.options && !q.options.includes(v)) throw new Error(`${q.id}: unknown option '${v}'`);
    return;
  }
  if (q.answer_type === 'multi_chips') {
    const list = asList(v);
    if (!list.length) throw new Error(`${q.id}: pick at least one`);
    if (q.options) for (const x of list) if (!q.options.includes(x)) throw new Error(`${q.id}: unknown option '${x}'`);
    return;
  }
  if (q.max_items) {
    // A list (possibly empty: every sample removed) replaces what is kept; a string appends one item.
    if (Array.isArray(v) && v.length > q.max_items) throw new Error(`${q.id}: at most ${q.max_items}`);
    if (!Array.isArray(v) && !asStr(v)) throw new Error(`${q.id}: empty answer`);
    return;
  }
  if (!asStr(v)) throw new Error(`${q.id}: empty answer`);
}
