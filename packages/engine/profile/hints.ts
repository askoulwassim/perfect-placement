import type { ProfileComponentKey } from '@perfect-placement/contracts';
import { coreTitle, detectPersona, type Persona, type PersonaOptions, previewOptions, uniq } from './persona.js';
import { bullets, type ResumeDraft, stripMd } from './resume.js';

/*
 * Resume-adaptive interview (#22): what the resume implies per component, with a confidence.
 *
 * A hint is a draft, not a fact: it is never written to the profile until the user confirms it.
 * At or above CONFIRM_MIN the interview asks "Looks like ... Right?" (Yes / Edit); below it, the
 * component's questions are asked as usual with the hint pre-filled. The onboard agent run replaces
 * these preview hints through `onboard.extract { drafts }` (judgment belongs to a model); this
 * heuristic is the instant preview and what tests use. It only reads the resume text.
 */

export const CONFIRM_MIN = 0.7;

export type HintedComponent = 'story' | 'craft' | 'domain' | 'growth' | 'voice';

export interface ComponentHint {
  /** Fields the interview confirms (Yes / Edit): confidence at or above CONFIRM_MIN. */
  data: Record<string, unknown>;
  /** Fields only pre-filled in the component's questions (low confidence). */
  suggest: Record<string, unknown>;
  confidence: number;
  /** What was pulled from the resume, shown before asking. */
  items: string[];
  by: 'preview' | 'agent';
}

export type ResumeHints = Partial<Record<ProfileComponentKey, ComponentHint>>;

const round = (n: number) => Math.round(n * 100) / 100;

/** A hint whose fields go to `data` or `suggest` by confidence; null when it has nothing. */
export function makeHint(
  fields: Record<string, unknown>,
  confidence: number,
  items: string[],
  by: ComponentHint['by'],
): ComponentHint | null {
  const kept = Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && v.length === 0)));
  if (!Object.keys(kept).length) return null;
  const high = confidence >= CONFIRM_MIN;
  return { data: high ? kept : {}, suggest: high ? {} : kept, confidence: round(confidence), items: items.slice(0, 6), by };
}

// ------------------------------------------------------------------ domain

/** Domain options (questions.ts domain.ranked) and the resume words that point at them. */
const DOMAIN_WORDS: Array<[string, RegExp]> = [
  ['data platforms', /\b(data platforms?|data infrastructure|data warehouse|warehouse|lakehouse|etl|data pipelines?|analytics|dbt|bi)\b/gi],
  ['AI infra', /\b(ml infra|ai infra|inference|gpus?|model serving|mlops|ml platform|feature store)\b/gi],
  ['frontier AI', /\b(llms?|large language models?|generative ai|genai|foundation models?|ai agents?)\b/gi],
  ['developer tools', /\b(developer tools?|devtools|sdks?|developer experience|ides?|ci\/cd|open source)\b/gi],
  ['fintech', /\b(fintech|payments?|banking|lending|trading|card issuing)\b/gi],
  ['healthcare', /\b(health ?care|clinical|clinicians?|patients?|hospitals?|ehr|medical|care teams?)\b/gi],
  ['security', /\b(security|identity|iam|threat|zero trust|soc ?2|vulnerabilit(y|ies))\b/gi],
];

function domainHint(text: string): ComponentHint | null {
  const counts = DOMAIN_WORDS.map(([name, re]) => [name, text.match(re)?.length ?? 0] as const)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]);
  if (!counts.length) return null;
  const top = counts[0]?.[1] ?? 0;
  const ranked = counts.slice(0, 3).map(([name]) => name);
  return makeHint(
    { ranked },
    top >= 4 ? 0.8 : 0.55,
    counts.slice(0, 3).map(([name, n]) => `${name}: ${n} mentions`),
    'preview',
  );
}

// ------------------------------------------------------------------ craft + growth

const LEVEL_RANK: Record<string, number> = { senior: 2, lead: 2, staff: 3, principal: 4, group: 5, head: 6, director: 6, vp: 7 };
const LEVEL_OF: Array<[RegExp, string]> = [
  [/\b(vp|vice president)\b/i, 'vp'],
  [/\bhead of\b/i, 'head'],
  [/\bdirector\b/i, 'director'],
  [/\bgroup\b/i, 'group'],
  [/\bprincipal\b/i, 'principal'],
  [/\bstaff\b/i, 'staff'],
  [/\b(senior|sr\.?)\b/i, 'senior'],
];
const levelRank = (title: string): number => {
  const l = LEVEL_OF.find(([re]) => re.test(title))?.[1];
  return l ? (LEVEL_RANK[l] ?? 1) : /\b(analyst|associate|junior|intern)\b/i.test(title) ? 0 : 1;
};
/** The growth.ceiling option one step above a level when no persona is recognized (the product ladder). */
const NEXT_SCOPE: Record<string, string> = {
  senior: 'principal IC',
  staff: 'principal IC',
  principal: 'group PM',
  group: 'head of product',
  head: 'VP product',
  director: 'VP product',
  vp: 'founder',
};

type Role = { company?: string; title?: string; dates?: string; bullets?: string[] };
const rolesOf = (story: Record<string, unknown>): Role[] => (Array.isArray(story.roles) ? (story.roles as Role[]) : []);

/** The resume's job titles, newest first, specialty dropped (#74): suggested for craft.titles, never confirmed. */
export function resumeTitles(story: Record<string, unknown>): string[] {
  const roles = rolesOf(story)
    .map((r) => r.title ?? '')
    .filter((t) => t && !/^(early roles?|various)$/i.test(t));
  const headline = typeof story.headline === 'string' && story.headline.split(/\s+/).length <= 8 ? [story.headline] : [];
  return uniq((roles.length ? roles : headline).map(coreTitle), 4);
}

function craftHint(parsed: ResumeDraft): ComponentHint | null {
  const c = parsed.craft;
  const latest = rolesOf(parsed.story)[0];
  const items = [
    latest?.title ? `${latest.title}${latest.company ? ` at ${latest.company}` : ''}` : '',
    Array.isArray(c.functions) && c.functions.length ? `Function: ${(c.functions as string[]).join(', ')}` : '',
    typeof c.level === 'string' ? `Level: ${c.level}` : '',
  ].filter(Boolean);
  const fields: Record<string, unknown> = {};
  if (Array.isArray(c.functions)) fields.functions = c.functions;
  if (typeof c.level === 'string') fields.level = c.level;
  if (typeof c.mode === 'string') fields.mode = c.mode;
  // Titles name the function and level plainly; a mode derived from the level alone is weaker.
  const conf = fields.level && fields.functions ? 0.85 : 0.6;
  return withTitles(makeHint(fields, conf, items, 'preview'), resumeTitles(parsed.story), items);
}

/** The resume's titles as a craft.titles suggestion (#74): pre-filled, never part of the confirm. */
export function withTitles(h: ComponentHint | null, titles: string[], items: string[] = []): ComponentHint | null {
  if (!titles.length) return h;
  if (!h) return { data: {}, suggest: { titles }, confidence: 0.5, items: items.slice(0, 6), by: 'preview' };
  return { ...h, suggest: { ...h.suggest, titles } };
}

function growthHint(parsed: ResumeDraft, persona: Persona | null): ComponentHint | null {
  const titles = rolesOf(parsed.story)
    .map((r) => r.title ?? '')
    .filter(Boolean);
  if (!titles.length) return null;
  const ranks = titles.map(levelRank);
  const newest = ranks[0] ?? 1;
  const oldest = ranks.at(-1) ?? newest;
  const level = typeof parsed.craft.level === 'string' ? parsed.craft.level : undefined;
  const fields: Record<string, unknown> = {};
  if (titles.length > 1) fields.trajectory = newest > oldest ? 'up' : 'steady';
  const next = persona?.next ?? NEXT_SCOPE;
  if (level && next[level]) fields.scope_ceiling = next[level];
  // Where someone wants to go next is theirs to say: growth is always asked, only pre-filled.
  return makeHint(fields, 0.5, [`Title path: ${[...titles].reverse().join(' > ')}`], 'preview');
}

// ------------------------------------------------------------------ voice

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

function voiceHint(text: string, story: Record<string, unknown>): ComponentHint | null {
  // The person's own writing: role bullets (skills and education lists are not prose).
  const fromRoles = rolesOf(story).flatMap((r) => r.bullets ?? []);
  const bs = (fromRoles.length ? fromRoles : bullets(text.split(/\r?\n/))).map(stripMd);
  const summary = typeof story.summary === 'string' ? story.summary : '';
  const sentences = summary.split(/(?<=[.!?])\s+/).filter((x) => words(x) > 2);
  if (bs.length < 2 && !sentences.length) return null;
  const avg = bs.length ? bs.reduce((a, b) => a + words(b), 0) / bs.length : 0;
  const metric = bs.length ? bs.filter((b) => /\d/.test(b)).length / bs.length : 0;
  const avgSentence = sentences.length ? sentences.reduce((a, b) => a + words(b), 0) / sentences.length : 0;
  const items = [
    bs.length ? `Bullets average ${Math.round(avg)} words` : '',
    bs.length ? `${Math.round(metric * 100)}% of bullets carry a number` : '',
    sentences.length ? `Summary sentences average ${Math.round(avgSentence)} words` : '',
  ].filter(Boolean);
  if (bs.length >= 2 && avg <= 14 && metric >= 0.4) return makeHint({ style: 'punchy' }, 0.75, items, 'preview');
  if ((bs.length >= 2 && avg >= 22) || avgSentence >= 25) return makeHint({ style: 'formal' }, 0.7, items, 'preview');
  return makeHint({ style: 'plain' }, 0.45, items, 'preview');
}

// ------------------------------------------------------------------ story

/** Identity fields the interview confirms or edits (#124): Story `contact` minus email and LinkedIn. */
export const IDENTITY_KEYS = ['full_name', 'preferred_name', 'phone', 'city'] as const;

/** The identity and contact pulled from the resume (#124), as strings. */
export function contactOf(story: Record<string, unknown>): Record<string, string> {
  const c = story.contact;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
  return Object.fromEntries(Object.entries(c).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1].trim()));
}

/** "Alex Rivera · +1 555 010 0199 · Springfield, IL": what the interview shows for the contact. */
export function contactLine(c: Record<string, unknown>): string {
  return [c.full_name, c.preferred_name ? `goes by ${String(c.preferred_name)}` : '', c.phone, c.city]
    .filter((x): x is string => typeof x === 'string' && !!x)
    .join(' · ');
}

function storyHint(text: string, story: Record<string, unknown>): ComponentHint | null {
  const roles = rolesOf(story);
  const wins = Array.isArray(story.wins) ? (story.wins as string[]) : [];
  const headline = typeof story.headline === 'string' ? story.headline : undefined;
  const contact = contactOf(story);
  const items = [
    contact.full_name ? `Contact: ${contactLine(contact)}` : '',
    headline ? `Headline: ${headline}` : '',
    roles.length ? `${roles.length} role${roles.length === 1 ? '' : 's'}, latest ${roles[0]?.title ?? ''}`.trim() : '',
    wins.length ? `${wins.length} win${wins.length === 1 ? '' : 's'} with a number` : '',
    typeof story.years === 'number' ? `${story.years} years (${String(story.years_basis)})` : '',
  ].filter(Boolean);
  if (!items.length) return null;
  // A "Title:" line is the person's own headline; a heading line is a weaker guess.
  const conf = headline ? (/\*\*Title:\*\*/i.test(text) || story.extracted_by === 'agent' ? 0.9 : 0.6) : 0.5;
  const by = story.extracted_by === 'agent' ? 'agent' : 'preview';
  // #124: a name line read from the resume is confirmed (Yes / Edit) with the headline when that is sure too.
  if (contact.full_name) {
    const sure = !!headline && conf >= CONFIRM_MIN;
    return {
      data: { contact, ...(sure ? { headline } : {}) },
      suggest: headline && !sure ? { headline } : {},
      confidence: Math.max(conf, 0.8),
      items: items.slice(0, 6),
      by,
    };
  }
  const hint = makeHint(headline ? { headline } : {}, conf, items, by);
  // Roles and wins are verbatim facts with no field to confirm: still shown as pulled.
  return hint ?? { data: {}, suggest: {}, confidence: conf, items, by: 'preview' };
}

/** Hints for every component the resume informs (instant preview). */
export function resumeHints(text: string, parsed: ResumeDraft): ResumeHints {
  const out: ResumeHints = {};
  const set = (k: HintedComponent, h: ComponentHint | null) => {
    if (h) out[k] = h;
  };
  set('story', storyHint(text, parsed.story));
  set('craft', craftHint(parsed));
  set('domain', domainHint(text));
  set('growth', growthHint(parsed, personaOfResume(parsed)));
  set('voice', voiceHint(text, parsed.story));
  return out;
}

/** The persona the resume's headline and role titles point at (#74). */
export function personaOfResume(parsed: ResumeDraft): Persona | null {
  const headline = typeof parsed.story.headline === 'string' ? [parsed.story.headline] : [];
  return detectPersona([...headline, ...rolesOf(parsed.story).map((r) => r.title ?? '')]);
}

/** The instant preview's persona-dependent options (#74): from the resume's persona, titles, functions and domains. */
export function resumeOptions(parsed: ResumeDraft, hints: ResumeHints): PersonaOptions {
  const headline = typeof parsed.story.headline === 'string' ? [parsed.story.headline] : [];
  const d = hints.domain;
  const ranked = d ? ((d.data.ranked ?? d.suggest.ranked ?? []) as string[]) : [];
  return previewOptions({
    titles: resumeTitles(parsed.story),
    personaTitles: [...headline, ...rolesOf(parsed.story).map((r) => r.title ?? '')],
    functions: Array.isArray(parsed.craft.functions) ? (parsed.craft.functions as string[]) : [],
    domains: ranked,
  });
}

/** Hint from the agent's extracted Story (verbatim facts; the headline is confirmed). */
export function storyHintFrom(text: string, story: Record<string, unknown>): ComponentHint | null {
  return storyHint(text, story);
}

/** Short lines describing a draft's data (agent drafts without evidence). */
export function describeData(data: Record<string, unknown>): string[] {
  return Object.entries(data)
    .filter(([k]) => !['criterion_weights', 'criteria', 'dictated', 'follow_ups'].includes(k))
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .slice(0, 6);
}
