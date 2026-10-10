import { PROFILE_COMPONENT_KEYS, type ProfileComponentKey, VOICE_SAMPLE_MAX_CHARS, VOICE_SAMPLES_MAX } from '@perfect-placement/contracts';
import { CONFIRM_MIN, type ComponentHint, contactOf, IDENTITY_KEYS, type ResumeHints } from './hints.js';
import { deepEqual } from './json.js';
import { FALLBACK_OPTIONS, type OptionKey, type PersonaOptions, personaOfCraft, titlesForFunctions, uniq } from './persona.js';

/*
 * Onboarding question bank: two to four adaptive questions per component, chips or
 * sliders over free text.
 *
 * Wording (#23, wave1-decisions #28): every question is a full, plain sentence a first-time user
 * understands without context, with an optional one-line example. The one to three word rule is for
 * buttons and labels, not interview questions. No two questions ask for the same thing: Company asks
 * where you would love to work (affinity), Network where you already know people (warm paths);
 * industries are asked once (Domain avoid), relocation once (a hard no answers the default).
 * Every question can be skipped ("I don't know").
 *
 * Skip logic: a question is skipped when `known(draft)` is true, i.e. the resume (or
 * an earlier answer, or the current profile) already answered it. "Never ask what the
 * resume answers." A scoped re-interview of one component ignores `known` so the
 * questions are asked again.
 *
 * Resume-adaptive (#22): with an interview plan, a component the resume informs with high
 * confidence opens with a confirm question ("Looks like ... Right?", yes / edit); low-confidence
 * hints pre-fill the component's questions (`suggested`); follow-ups the onboard agent proposed
 * (`onboard.propose_questions`) are asked after the component's bank questions.
 *
 * Persona-dependent options (#74): Craft functions, level and titles, Domain and the Growth scope are not a
 * fixed product-manager list. Their options come from the session's plan (`options`: the onboard agent's,
 * else the instant preview's, both from the resume), else the persona of the Craft draft (a re-interview),
 * else the static fallback; the draft's and the resume's own values are always among them, and free entry
 * (Other) is always accepted.
 */

export type Draft = Partial<Record<ProfileComponentKey, Record<string, unknown>>>;
/** `list` (#75): free entries the UI keeps as chips; a string[] answer (a comma separated string still parses). */
export type AnswerType = 'chips' | 'multi_chips' | 'slider' | 'text' | 'list';
export type AnswerValue = string | number | string[];

export type QuestionKind = 'ask' | 'confirm' | 'follow_up';

export interface QuestionDef {
  id: string;
  component: ProfileComponentKey;
  /** A full sentence (#23). */
  label: string;
  /** Optional one-line example shown under the question. */
  example?: string;
  kind?: QuestionKind;
  /** Component fields this question fills (resume hints pre-fill them; a confirm covers them). */
  fields?: string[];
  answer_type: AnswerType;
  options?: string[];
  /** Options that depend on the draft (story.years: the derived number or leave it out). */
  optionsFor?: (d: Draft) => string[];
  /** Persona-dependent options (#74): which list of the plan's options this question shows. */
  persona?: OptionKey;
  /** Free entry is accepted besides the options (#74: the UI's Other). */
  other?: boolean;
  /** Free text that may be dictated: fillers are stripped (cleanDictation) and the raw text kept. Default true for text. */
  dictated?: boolean;
  min?: number;
  max?: number;
  /** Slider step (#73: 1k for money; the UI moves 5k with Shift). */
  step?: number;
  /** What a slider measures, so the UI formats it (#73). */
  unit?: 'money' | 'percent';
  /** List text question: a string answer appends one item, a string[] answer replaces the list. */
  max_items?: number;
  max_chars?: number;
  /** The list kept so far (list questions). */
  items?: (d: Draft) => string[];
  /** Added (#124): the Story `contact` key this question sets (fields is ['contact']). */
  contactKey?: (typeof IDENTITY_KEYS)[number];
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
/** A list answer: a string[] (#75 chips), or a comma / new line separated string (older callers). Duplicates dropped. */
export const asList = (v: AnswerValue): string[] => [
  ...new Set((Array.isArray(v) ? v : String(v).split(/[,\n]/)).map((s) => String(s).trim()).filter(Boolean)),
];
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

/** Application defaults (#42) live in Terms `application_defaults`. */
const defaultsOf = (d: Draft) => {
  const t = comp(d, 'terms');
  t.application_defaults ??= {};
  return t.application_defaults as Record<string, unknown>;
};
const knownDefault = (f: string) => (d: Draft) => {
  const v = (d.terms?.application_defaults as Record<string, unknown> | undefined)?.[f];
  return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
};
const setDefault =
  (f: string, conv: (v: AnswerValue) => unknown = asStr) =>
  (d: Draft, v: AnswerValue) => {
    defaultsOf(d)[f] = conv(v);
  };

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

/** Story `contact` (#124), created on first write. */
const contactOfDraft = (d: Draft) => {
  const c = comp(d, 'story');
  if (!c.contact || typeof c.contact !== 'object' || Array.isArray(c.contact)) c.contact = {};
  return c.contact as Record<string, unknown>;
};
const knownContact = (f: string) => (d: Draft) => !!contactOf(d.story ?? {})[f];
/** An identity question (#124): one Story `contact` field, free text, pre-filled from the resume. */
const identityQuestion = (id: string, f: (typeof IDENTITY_KEYS)[number], label: string, example?: string): QuestionDef => ({
  id,
  component: 'story',
  label,
  ...(example ? { example } : {}),
  answer_type: 'text',
  fields: ['contact'],
  contactKey: f,
  dictated: false,
  known: (d) => knownContact(f)(d) || knownContact('full_name')(d),
  apply: (d, v) => {
    const t = asStr(v).replace(/\s+/g, ' ');
    if (t) contactOfDraft(d)[f] = t;
    else delete contactOfDraft(d)[f];
  },
});

/** story.years option that drops a derived number. */
export const YEARS_LEAVE_OUT = 'leave out';

export const QUESTION_BANK: QuestionDef[] = [
  // Story: the resume normally answers these.
  {
    id: 'story.headline',
    component: 'story',
    label: 'How would you describe yourself in one line?',
    example: 'Example: Principal PM for data platforms and AI products.',
    answer_type: 'text',
    fields: ['headline'],
    known: known('story', 'headline'),
    apply: set('story', 'headline'),
  },
  {
    id: 'story.win',
    component: 'story',
    label: 'What is the win you are proudest of, with a number if you have one?',
    example: 'Example: Cut warehouse spend 30% with usage-based pricing.',
    answer_type: 'text',
    fields: ['wins'],
    known: known('story', 'wins'),
    apply: (d, v) => {
      comp(d, 'story').wins = [asStr(v)];
    },
  },
  {
    // Years are never guessed (#38): a number derived from the role dates is shown for confirmation.
    id: 'story.years',
    component: 'story',
    label: 'Your role dates add up to this many years of experience. Should we use that number?',
    answer_type: 'chips',
    optionsFor: (d) => [String(d.story?.years ?? ''), YEARS_LEAVE_OUT].filter(Boolean),
    known: () => false,
    when: (d) => d.story?.years_basis === 'from dates' && typeof d.story?.years === 'number',
    apply: (d, v) => {
      const c = comp(d, 'story');
      if (asStr(v) === YEARS_LEAVE_OUT) {
        delete c.years;
        delete c.years_basis;
      } else {
        c.years = asNum(v);
        c.years_basis = 'confirmed';
      }
    },
  },
  // Story identity (#124): Fill uses these for the portal's identity fields. A name read from the resume is
  // confirmed with Story (Yes / Edit), so these are asked only on Edit or when the resume has no name line:
  // each is known once a full name is kept, which is why the name comes last.
  identityQuestion('story.preferred_name', 'preferred_name', 'What first name do you go by?', 'Example: AJ.'),
  identityQuestion('story.phone', 'phone', 'What phone number should employers call?', 'Example: +1 555 010 0199.'),
  identityQuestion('story.city', 'city', 'Which city do you live in?', 'Example: Springfield, IL.'),
  identityQuestion('story.name', 'full_name', 'What full name should applications use?', 'Example: Alex J. Rivera.'),
  // Craft
  {
    id: 'craft.functions',
    component: 'craft',
    label: 'What kind of work do you want to do in your next role?',
    example: 'Pick one or more. The first is your main one.',
    answer_type: 'multi_chips',
    options: FALLBACK_OPTIONS.functions,
    persona: 'functions',
    other: true,
    fields: ['functions'],
    known: known('craft', 'functions'),
    apply: set('craft', 'functions', asList),
  },
  {
    id: 'craft.level',
    component: 'craft',
    label: 'What level are you aiming for in your next role?',
    answer_type: 'chips',
    options: FALLBACK_OPTIONS.levels,
    persona: 'levels',
    other: true,
    fields: ['level'],
    known: known('craft', 'level'),
    apply: set('craft', 'level'),
  },
  {
    id: 'craft.mode',
    component: 'craft',
    label: 'Do you want to be an individual contributor, lead a team, or either?',
    answer_type: 'chips',
    options: ['ic', 'lead', 'either'],
    fields: ['mode'],
    known: known('craft', 'mode'),
    apply: set('craft', 'mode'),
  },
  {
    id: 'craft.facing',
    component: 'craft',
    label: 'Do you want to build for external customers, internal teams, or either?',
    answer_type: 'chips',
    options: ['external', 'internal', 'either'],
    fields: ['facing'],
    known: known('craft', 'facing'),
    apply: set('craft', 'facing'),
  },
  {
    // #74: the titles the scout searches for, from the resume's persona (a salesperson sees sales titles).
    id: 'craft.titles',
    component: 'craft',
    label: 'Which job titles should we search for?',
    example: 'Pick one or more, or add your own.',
    answer_type: 'multi_chips',
    options: FALLBACK_OPTIONS.titles,
    persona: 'titles',
    other: true,
    fields: ['titles'],
    known: known('craft', 'titles'),
    apply: set('craft', 'titles', asList),
  },
  // Domain
  {
    id: 'domain.ranked',
    component: 'domain',
    label: 'Which domains do you want to work in, in order of preference?',
    example: 'Pick in order. The first counts most.',
    answer_type: 'multi_chips',
    options: FALLBACK_OPTIONS.domains,
    persona: 'domains',
    other: true,
    fields: ['ranked'],
    known: known('domain', 'ranked'),
    apply: set('domain', 'ranked', asList),
  },
  {
    // The only industry question: Dealbreakers no longer lists industries (#23).
    id: 'domain.avoid',
    component: 'domain',
    label: 'Which industries would you rather not work in?',
    answer_type: 'multi_chips',
    options: ['ad tech', 'gambling', 'crypto', 'defense', 'none', 'other'],
    fields: ['avoid'],
    known: known('domain', 'avoid'),
    apply: (d, v) => {
      comp(d, 'domain').avoid = asList(v).filter((x) => x !== 'none');
    },
  },
  // Work mode
  {
    id: 'work_mode.modes',
    component: 'work_mode',
    label: 'Which ways of working are you open to?',
    answer_type: 'multi_chips',
    options: ['remote', 'hybrid', 'onsite'],
    fields: ['modes'],
    known: known('work_mode', 'modes'),
    apply: set('work_mode', 'modes', asList),
  },
  {
    id: 'work_mode.remote_only',
    component: 'work_mode',
    label: 'Should every hybrid or onsite role be ruled out, wherever it is?',
    example: 'Say no if hybrid in a city you listed would work.',
    answer_type: 'chips',
    options: ['no', 'yes'],
    fields: ['remote_only'],
    known: known('work_mode', 'remote_only'),
    // Asked only when remote is the one mode picked (#83): remote only is never implied.
    when: (d) => {
      const modes = (d.work_mode?.modes as string[] | undefined) ?? [];
      return modes.length === 1 && modes[0] === 'remote';
    },
    apply: (d, v) => {
      comp(d, 'work_mode').remote_only = String(v).trim().toLowerCase() === 'yes';
    },
  },
  {
    id: 'work_mode.locations',
    component: 'work_mode',
    label: 'Which cities or regions can you work from?',
    example: 'Example: New York, US remote.',
    answer_type: 'list',
    fields: ['locations'],
    known: known('work_mode', 'locations'),
    apply: set('work_mode', 'locations', asList),
  },
  {
    id: 'work_mode.travel',
    component: 'work_mode',
    label: 'What is the most travel you would accept, as a share of your time?',
    answer_type: 'slider',
    min: 0,
    max: 100,
    step: 5,
    unit: 'percent',
    fields: ['travel_max_pct'],
    known: known('work_mode', 'travel_max_pct'),
    apply: set('work_mode', 'travel_max_pct', asNum),
  },
  // Terms
  {
    id: 'terms.floor',
    component: 'terms',
    label: 'What is the lowest base salary you would accept?',
    answer_type: 'slider',
    min: 0,
    max: 600000,
    step: 1000,
    unit: 'money',
    fields: ['comp_floor'],
    known: known('terms', 'comp_floor'),
    apply: set('terms', 'comp_floor', asNum),
  },
  {
    id: 'terms.target',
    component: 'terms',
    label: 'What base salary are you aiming for?',
    answer_type: 'slider',
    min: 0,
    max: 800000,
    step: 1000,
    unit: 'money',
    fields: ['comp_target'],
    known: known('terms', 'comp_target'),
    apply: set('terms', 'comp_target', asNum),
  },
  {
    id: 'terms.equity',
    component: 'terms',
    label: 'How much does equity matter to you?',
    answer_type: 'chips',
    options: ['low', 'medium', 'high'],
    fields: ['equity'],
    known: known('terms', 'equity'),
    apply: set('terms', 'equity'),
  },
  // Company: where you would love to work (affinity). Network, next, is where you already know people.
  {
    id: 'company.stages',
    component: 'company',
    label: 'Which company stages appeal to you?',
    answer_type: 'multi_chips',
    options: ['seed', 'series-a', 'series-b', 'series-c', 'growth', 'public', 'any'],
    fields: ['stages'],
    known: known('company', 'stages'),
    apply: set('company', 'stages', asList),
  },
  {
    id: 'company.size',
    component: 'company',
    label: 'How big a company do you want to join, by headcount?',
    answer_type: 'chips',
    options: ['1-50', '50-200', '200-1000', '1000-5000', '5000+', 'any'],
    fields: ['size'],
    known: known('company', 'size'),
    apply: set('company', 'size'),
  },
  {
    id: 'company.dream',
    component: 'company',
    label: 'Which companies would you love to work at?',
    example: 'Example: Anthropic, Stripe, Figma.',
    answer_type: 'list',
    fields: ['dream_companies'],
    known: known('company', 'dream_companies'),
    apply: (d, v) => {
      const names = asList(v);
      const c = comp(d, 'company');
      c.dream_companies = names;
      // Capped nudge (decisions.md #5): +3 default, never a dealbreaker bypass.
      c.affinity = { ...((c.affinity as Record<string, number>) ?? {}), ...Object.fromEntries(names.map((n) => [slug(n), 3])) };
    },
  },
  // Network (LinkedIn fills this later; one optional seed question), right after Company (#23).
  {
    id: 'network.warm',
    component: 'network',
    label: 'Where do you already know people who could introduce you?',
    example: 'Companies where a friend or former colleague works now.',
    answer_type: 'list',
    fields: ['warm_companies'],
    known: known('network', 'warm_companies'),
    apply: set('network', 'warm_companies', asList),
  },
  // Team
  {
    id: 'team.proximity',
    component: 'team',
    label: 'How close to the top decision maker do you want to sit?',
    answer_type: 'chips',
    options: ['reports to founder or CEO', 'reports to VP or above', 'one more layer', 'other'],
    fields: ['proximity'],
    known: known('team', 'proximity'),
    apply: set('team', 'proximity'),
  },
  {
    id: 'team.size',
    component: 'team',
    label: 'Do you prefer working on a small team, or does team size not matter?',
    answer_type: 'chips',
    options: ['small', 'any'],
    fields: ['prefers_small_teams'],
    known: known('team', 'prefers_small_teams'),
    apply: (d, v) => {
      comp(d, 'team').prefers_small_teams = asStr(v) === 'small';
    },
  },
  // Growth
  {
    id: 'growth.ceiling',
    component: 'growth',
    label: 'What scope do you want to grow into next?',
    answer_type: 'chips',
    options: FALLBACK_OPTIONS.scopes,
    persona: 'scopes',
    other: true,
    fields: ['scope_ceiling'],
    known: known('growth', 'scope_ceiling'),
    apply: set('growth', 'scope_ceiling'),
  },
  {
    id: 'growth.trajectory',
    component: 'growth',
    label: 'How do you want your career to move from here?',
    example: 'Up: more scope. Broader: more areas. Deeper: more expertise. Steady: the same.',
    answer_type: 'chips',
    options: ['up', 'broader', 'deeper', 'steady'],
    fields: ['trajectory'],
    known: known('growth', 'trajectory'),
    apply: set('growth', 'trajectory'),
  },
  // Dealbreakers
  {
    id: 'dealbreakers.hard_nos',
    component: 'dealbreakers',
    label: 'What would make you turn down a role, no matter what else it offers?',
    answer_type: 'multi_chips',
    options: ['onsite only', 'relocation', 'below comp floor', 'deeply layered org', 'other'],
    fields: ['hard_nos'],
    known: known('dealbreakers', 'hard_nos'),
    apply: (d, v) => {
      const nos = asList(v);
      comp(d, 'dealbreakers').hard_nos = nos;
      // Relocation as a hard no answers the relocation default (asked once, #23).
      if (nos.includes('relocation') && !knownDefault('relocation')(d)) defaultsOf(d).relocation = 'no';
    },
  },
  {
    id: 'dealbreakers.other',
    component: 'dealbreakers',
    label: 'Name the other things that rule a role out for you.',
    answer_type: 'list',
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
    label: 'How do you want your writing to sound?',
    answer_type: 'chips',
    options: ['punchy', 'warm', 'formal', 'plain'],
    fields: ['style'],
    known: known('voice', 'style'),
    apply: set('voice', 'style'),
  },
  {
    id: 'voice.sample',
    component: 'voice',
    label: 'Paste a few things you have written that sound like you.',
    example: 'Example: a LinkedIn post, an email or a cover letter you liked.',
    answer_type: 'text',
    max_items: VOICE_SAMPLES_MAX,
    max_chars: VOICE_SAMPLE_MAX_CHARS,
    items: (d) => voiceSamplesOf(d),
    fields: ['samples'],
    known: known('voice', 'samples'),
    apply: (d, v) => {
      comp(d, 'voice').samples = nextSamples(voiceSamplesOf(d), v);
    },
  },
  // Application defaults (#42): standard portal answers, saved once (Terms `application_defaults`).
  // Last: they are logistics, and a relocation hard no already answers relocation.
  {
    id: 'defaults.sponsorship',
    component: 'terms',
    label: 'Will you now or in the future need visa sponsorship to work?',
    answer_type: 'chips',
    options: ['no', 'yes'],
    known: knownDefault('sponsorship'),
    apply: setDefault('sponsorship'),
  },
  {
    id: 'defaults.authorized_countries',
    component: 'terms',
    label: 'Which countries can you work in without sponsorship?',
    example: 'Example: United States, Canada.',
    answer_type: 'list',
    known: knownDefault('authorized_countries'),
    apply: setDefault('authorized_countries', asList),
  },
  {
    id: 'defaults.relocation',
    component: 'terms',
    label: 'Are you open to relocating for the right role?',
    answer_type: 'chips',
    options: ['no', 'yes', 'depends on the role'],
    known: (d) => knownDefault('relocation')(d) || has(d, 'work_mode', 'relocation'),
    apply: setDefault('relocation'),
  },
  {
    id: 'defaults.notice_period',
    component: 'terms',
    label: 'How much notice do you need before you can start?',
    answer_type: 'chips',
    options: ['none', '2 weeks', '1 month', '2 months', '3 months'],
    known: knownDefault('notice_period'),
    apply: setDefault('notice_period'),
  },
  {
    id: 'defaults.in_office',
    component: 'terms',
    label: 'How many days a week can you work from an office?',
    answer_type: 'chips',
    options: ['0', '1-2', '3', '4-5'],
    known: knownDefault('in_office'),
    // Remote only answers it already (#83: only when explicit).
    when: (d) => d.work_mode?.remote_only !== true,
    apply: setDefault('in_office'),
  },
  {
    id: 'defaults.eeo',
    component: 'terms',
    label: 'How should we answer optional demographic (EEO) questions?',
    answer_type: 'chips',
    options: ['prefer not to say', 'ask me each time'],
    known: knownDefault('eeo'),
    apply: setDefault('eeo', (v) => (asStr(v) === 'prefer not to say' ? 'Prefer not to say' : asStr(v))),
  },
];

// ------------------------------------------------------------ interview plan (#22)

/** A follow-up question the onboard agent proposed (`onboard.propose_questions`). */
export interface ProposedQuestion {
  id: string;
  component: ProfileComponentKey;
  label: string;
  example?: string;
  answer_type: 'chips' | 'multi_chips' | 'text';
  options?: string[];
  reason?: string;
}

/** The resume-adaptive interview plan kept with the onboarding session (`interview_json`). */
export interface InterviewPlan {
  hints: ResumeHints;
  questions: ProposedQuestion[];
  /** Questions answered "I don't know". */
  skipped: string[];
  /** Persona-dependent options from the resume (#74): the agent's (`onboard.extract { options }`) or the preview's. */
  options?: PersonaOptions;
}

export const emptyPlan = (): InterviewPlan => ({ hints: {}, questions: [], skipped: [] });

export const CONFIRM_YES = 'yes';
export const CONFIRM_EDIT = 'edit';

/** Bank questions per component, in bank order. */
const BANK_BY_COMPONENT = (k: ProfileComponentKey) => QUESTION_BANK.filter((q) => q.component === k && !q.id.startsWith('defaults.'));

/** The fields of a component that an answered question set (an answer beats a hint). */
export function answeredFields(k: ProfileComponentKey, answered: readonly string[]): Set<string> {
  return new Set(BANK_BY_COMPONENT(k).flatMap((q) => (answered.includes(q.id) ? (q.fields ?? []) : [])));
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
const and = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const FUNCTION_NOUN: Record<string, string> = {
  Engineering: 'engineer',
  'Data Science': 'data scientist',
  FDE: 'forward deployed engineer',
  Sales: 'seller',
  'Account Management': 'account manager',
  'Business Development': 'business development lead',
  Marketing: 'marketer',
  Design: 'designer',
  'Customer Success': 'customer success lead',
};
const MODE_PHRASE: Record<string, string> = { ic: 'as an individual contributor', lead: 'leading a team', either: 'as an IC or a lead' };

/** "Looks like ... Right?" for a component's high-confidence hint. */
export function confirmLabel(k: ProfileComponentKey, data: Record<string, unknown>): string {
  if (k === 'story' && data.contact && typeof data.contact === 'object') {
    const c = contactOf({ contact: data.contact });
    const more = [c.preferred_name ? `goes by ${c.preferred_name}` : '', c.phone ?? '', c.city ?? ''].filter(Boolean);
    const who = `${c.full_name ?? ''}${more.length ? ` (${more.join(', ')})` : ''}`;
    const head = typeof data.headline === 'string' ? `, and your headline is "${data.headline}"` : '';
    return `Looks like you are ${who}${head}. Right?`;
  }
  if (k === 'story' && typeof data.headline === 'string') return `Looks like your headline is "${data.headline}". Right?`;
  if (k === 'craft') {
    const level = typeof data.level === 'string' ? data.level : '';
    const f0 = list(data.functions)[0] ?? '';
    const fn = FUNCTION_NOUN[f0] ?? f0;
    const who = [level, fn].filter(Boolean).join(' ');
    const mode = typeof data.mode === 'string' ? MODE_PHRASE[data.mode] : undefined;
    if (who) return `Looks like you work as ${/^[aeiou]/i.test(who) ? 'an' : 'a'} ${who}${mode ? `, ${mode}` : ''}. Right?`;
  }
  if (k === 'domain' && list(data.ranked).length) {
    const r = list(data.ranked);
    return `Looks like your strongest ${r.length > 1 ? 'domains are' : 'domain is'} ${and(r)}. Right?`;
  }
  if (k === 'growth' && typeof data.scope_ceiling === 'string') return `Looks like your next step is ${data.scope_ceiling}. Right?`;
  if (k === 'voice' && typeof data.style === 'string') return `Looks like you write in a ${data.style} style. Right?`;
  const parts = Object.entries(data).map(([f, v]) => `${f.replace(/_/g, ' ')} ${list(v).join(', ') || String(v)}`);
  return `Looks like your ${and(parts)}. Right?`;
}

/** The confirm question for a component, or null when its hint does not qualify. */
function confirmQuestion(k: ProfileComponentKey, hint: ComponentHint | undefined, answered: readonly string[]): QuestionDef | null {
  if (!hint || hint.confidence < CONFIRM_MIN || !Object.keys(hint.data).length) return null;
  const done = answeredFields(k, answered);
  // Everything it would confirm was already answered: nothing to confirm.
  if (Object.keys(hint.data).every((f) => done.has(f))) return null;
  return {
    id: `confirm.${k}`,
    component: k,
    kind: 'confirm',
    label: confirmLabel(k, hint.data),
    answer_type: 'chips',
    options: [CONFIRM_YES, CONFIRM_EDIT],
    known: () => false,
    apply: (d, v) => {
      const c = comp(d, k);
      const yes = asStr(v) === CONFIRM_YES;
      for (const [f, val] of Object.entries(hint.data)) {
        if (done.has(f)) continue;
        if (f === 'contact') {
          // #124: Yes merges the contact into what is kept (an email already there stays); Edit clears only
          // the identity questions' fields (email and LinkedIn have no question) so they are asked, pre-filled.
          const kept = contactOf(c);
          const hinted = val as Record<string, unknown>;
          if (yes) c.contact = { ...kept, ...hinted };
          else {
            for (const key of IDENTITY_KEYS) if (kept[key] === hinted[key]) delete kept[key];
            if (Object.keys(kept).length) c.contact = kept;
            else delete c.contact;
          }
        } else if (yes) c[f] = val;
        // Edit: the component's questions are asked, the hint pre-filled.
        else if (deepEqual(c[f], val)) delete c[f];
      }
    },
  };
}

function followUpQuestion(p: ProposedQuestion): QuestionDef {
  return {
    id: p.id,
    component: p.component,
    kind: 'follow_up',
    label: p.label,
    ...(p.example ? { example: p.example } : {}),
    answer_type: p.answer_type,
    ...(p.options ? { options: p.options } : {}),
    dictated: p.answer_type === 'text',
    known: () => false,
    apply: (d, v) => {
      const c = comp(d, p.component);
      const prev = Array.isArray(c.follow_ups) ? (c.follow_ups as Array<{ question: string; answer: string }>) : [];
      c.follow_ups = [...prev.filter((x) => x.question !== p.label), { question: p.label, answer: asStr(v) }];
    },
  };
}

/**
 * The interview in order: per component, its confirm question (full onboarding with a high-confidence
 * resume hint), its bank questions, then the agent's follow-ups. Application defaults come last.
 */
export function questionsFor(
  plan: InterviewPlan | null | undefined,
  answered: readonly string[],
  scope?: readonly ProfileComponentKey[] | null,
): QuestionDef[] {
  const out: QuestionDef[] = [];
  const seen = new Set<ProfileComponentKey>();
  const lastOf = new Map<ProfileComponentKey, string>();
  for (const q of QUESTION_BANK) if (!q.id.startsWith('defaults.')) lastOf.set(q.component, q.id);
  for (const q of QUESTION_BANK) {
    if (!seen.has(q.component) && !q.id.startsWith('defaults.')) {
      seen.add(q.component);
      const c = plan && !scope ? confirmQuestion(q.component, plan.hints[q.component], answered) : null;
      if (c) out.push(c);
    }
    out.push(q);
    if (plan && lastOf.get(q.component) === q.id)
      for (const p of plan.questions) if (p.component === q.component) out.push(followUpQuestion(p));
  }
  // Follow-ups for a component with no bank questions (none today) still get asked.
  if (plan) for (const p of plan.questions) if (!lastOf.has(p.component)) out.push(followUpQuestion(p));
  return out;
}

export function findQuestion(id: string, plan?: InterviewPlan | null, answered: readonly string[] = []): QuestionDef | undefined {
  const bank = QUESTION_BANK.find((q) => q.id === id);
  if (bank) return bank;
  if (!plan) return undefined;
  const m = /^confirm\.(.+)$/.exec(id);
  if (m && (PROFILE_COMPONENT_KEYS as readonly string[]).includes(m[1] ?? '')) {
    const k = m[1] as ProfileComponentKey;
    return (
      confirmQuestion(
        k,
        plan.hints[k],
        answered.filter((a) => a !== id),
      ) ?? undefined
    );
  }
  const p = plan.questions.find((x) => x.id === id);
  return p ? followUpQuestion(p) : undefined;
}

/** Next question to ask, or null when the interview is complete. */
export function nextQuestion(
  draft: Draft,
  answered: readonly string[],
  scope?: readonly ProfileComponentKey[] | null,
  plan?: InterviewPlan | null,
): QuestionDef | null {
  for (const q of questionsFor(plan, answered, scope)) {
    if (scope && !scope.includes(q.component)) continue;
    // #124: a re-interview leaves the contact alone (You edits it directly).
    if (scope && q.contactKey) continue;
    if (answered.includes(q.id)) continue;
    if (q.when && !q.when(draft)) continue;
    if (!scope && q.known(draft)) continue;
    return q;
  }
  return null;
}

/**
 * The options a question shows for this draft. Persona-dependent (#74): the plan's options, else the Craft
 * draft's persona, else the static fallback; the draft's current value and the resume's suggestion are kept
 * among them so they stay selectable.
 */
export function optionsOf(q: QuestionDef, d: Draft, plan?: InterviewPlan | null): string[] | undefined {
  if (q.optionsFor) return q.optionsFor(d);
  if (!q.persona) return q.options;
  const fromPlan = plan?.options?.[q.persona];
  const persona = fromPlan?.length ? null : personaOfCraft(d.craft);
  const fns = list(d.craft?.functions);
  const base = fromPlan?.length
    ? fromPlan
    : q.persona === 'titles' && fns.length
      ? titlesForFunctions(fns)
      : persona && q.persona !== 'titles'
        ? persona[q.persona]
        : (q.options ?? []);
  const f = q.fields?.[0];
  const hint = plan?.hints[q.component];
  const own = f ? [...list(d[q.component]?.[f]), ...(hint ? list(hint.data[f] ?? hint.suggest[f]) : [])] : [];
  // Titles: the user's own first. Other lists keep their order, the user's values added after.
  return q.persona === 'titles' ? uniq([...own, ...base], 14) : uniq([...base, ...own], 16);
}

/** The answer a resume hint suggests for an open question (pre-filled by the UI), if any. */
export function suggestedFor(q: QuestionDef, d: Draft, plan?: InterviewPlan | null): AnswerValue | undefined {
  const hint = plan?.hints[q.component];
  const f = q.fields?.[0];
  if (q.contactKey) return suggestedContact(q.contactKey, d, hint);
  if (!hint || !f || q.kind === 'confirm' || q.max_items) return undefined;
  const v = hint.data[f] ?? hint.suggest[f];
  if (v == null) return undefined;
  const options = optionsOf(q, d, plan);
  if (q.answer_type === 'chips') return typeof v === 'string' && (!options || options.includes(v)) ? v : undefined;
  if (q.answer_type === 'multi_chips') {
    const xs = list(v).filter((x) => !options || options.includes(x));
    return xs.length ? xs : undefined;
  }
  if (q.answer_type === 'slider') return typeof v === 'number' ? v : undefined;
  const xs = list(v);
  if (q.answer_type === 'list') return xs.length ? xs : undefined;
  return xs.length ? (f === 'wins' ? xs[0] : xs.join(', ')) : undefined;
}

/**
 * An identity question's pre-fill (#124): the resume's value, else for the preferred name the first word of
 * the full name.
 */
function suggestedContact(key: (typeof IDENTITY_KEYS)[number], d: Draft, hint: ComponentHint | undefined): string | undefined {
  const fromHint = { ...contactOf(hint?.suggest ?? {}), ...contactOf(hint?.data ?? {}) };
  const v = fromHint[key] ?? contactOf(d.story ?? {})[key];
  if (v) return v;
  if (key !== 'preferred_name') return undefined;
  const full = contactOf(d.story ?? {}).full_name ?? fromHint.full_name;
  return full?.split(/\s+/)[0]?.replace(/[.,]$/, '') || undefined;
}

/** Longest free entry (Other) for a persona-dependent option. */
export const OTHER_MAX_CHARS = 60;

/** Validate an answer against its question's type. Throws with a short message. */
export function checkAnswer(q: QuestionDef, v: AnswerValue, d: Draft = {}): void {
  const options = optionsOf(q, d);
  if (q.answer_type === 'slider') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error(`${q.id}: expected a number`);
    if ((q.min != null && n < q.min) || (q.max != null && n > q.max)) throw new Error(`${q.id}: out of range`);
    return;
  }
  // Free entry (#74): any short value besides the options.
  const known = (x: string) => q.other || !options || options.includes(x);
  if (q.answer_type === 'chips') {
    if (Array.isArray(v) || typeof v !== 'string' || !v.trim()) throw new Error(`${q.id}: expected one option`);
    if (!known(v)) throw new Error(`${q.id}: unknown option '${v}'`);
    if (q.other && v.length > OTHER_MAX_CHARS) throw new Error(`${q.id}: over ${OTHER_MAX_CHARS} chars`);
    return;
  }
  if (q.answer_type === 'multi_chips') {
    const list = asList(v);
    if (!list.length) throw new Error(`${q.id}: pick at least one`);
    for (const x of list) {
      if (!known(x)) throw new Error(`${q.id}: unknown option '${x}'`);
      if (q.other && x.length > OTHER_MAX_CHARS) throw new Error(`${q.id}: over ${OTHER_MAX_CHARS} chars`);
    }
    return;
  }
  if (q.answer_type === 'list') {
    if (!asList(v).length) throw new Error(`${q.id}: add at least one`);
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
