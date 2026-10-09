import type { ProfileComponentKey } from '@perfect-placement/contracts';
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
/** The growth.ceiling option one step above a level. */
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
  return makeHint(fields, conf, items, 'preview');
}

function growthHint(parsed: ResumeDraft): ComponentHint | null {
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
  if (level && NEXT_SCOPE[level]) fields.scope_ceiling = NEXT_SCOPE[level];
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

function storyHint(text: string, story: Record<string, unknown>): ComponentHint | null {
  const roles = rolesOf(story);
  const wins = Array.isArray(story.wins) ? (story.wins as string[]) : [];
  const headline = typeof story.headline === 'string' ? story.headline : undefined;
  const items = [
    headline ? `Headline: ${headline}` : '',
    roles.length ? `${roles.length} role${roles.length === 1 ? '' : 's'}, latest ${roles[0]?.title ?? ''}`.trim() : '',
    wins.length ? `${wins.length} win${wins.length === 1 ? '' : 's'} with a number` : '',
    typeof story.years === 'number' ? `${story.years} years (${String(story.years_basis)})` : '',
  ].filter(Boolean);
  if (!items.length) return null;
  // A "Title:" line is the person's own headline; a heading line is a weaker guess.
  const conf = headline ? (/\*\*Title:\*\*/i.test(text) || story.extracted_by === 'agent' ? 0.9 : 0.6) : 0.5;
  const hint = makeHint(headline ? { headline } : {}, conf, items, story.extracted_by === 'agent' ? 'agent' : 'preview');
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
  set('growth', growthHint(parsed));
  set('voice', voiceHint(text, parsed.story));
  return out;
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
