import type { ContactTier } from '@perfect-placement/contracts';
import { BRIDGE_ASK_MAX, defaultSignoff, LIMITS, PROOF_MAX_SENTENCES } from './style.js';
import type { DraftText, WriterPrompt } from './types.js';

/*
 * Draft templates per tier (blueprint.md "Connect"). Every draft reads as a short, natural email:
 *   Hook    = greeting + their world, one or two lines (reframe what they care about)
 *   Proof   = two or three sentences from STORY, numbers only if STORY has them
 *   Ask     = one small, specific ask (the close)
 *   Sign-off = in the user's voice (Voice `signoff`, else "Thanks," + first name)
 * Two kinds of input, kept apart in the prompt:
 *   CONTEXT = facts about them (contact headline, the role's JD, the company dossier): usable for the Hook
 *   STORY   = the only source of facts about the user
 * VOICE (style, notes, writing samples) shapes tone and rhythm only; facts in samples are never reused.
 * Text comes from the LLM writer (or the agent); `templateDraft` is a deterministic fallback.
 */

export interface TierTemplate {
  /** Who the Gmail draft is addressed to. Bridge drafts go to the mutual. */
  recipient: 'contact' | 'via';
  goal: string;
  ask: string;
  /** Cold, not hiring team: the blueprint says skip unless asked. */
  skipByDefault: boolean;
}

export const TIER_TEMPLATES: Record<ContactTier, TierTemplate> = {
  warm_hiring: {
    recipient: 'contact',
    goal: 'They know you and own or shape this hire. Ask for a conversation about the role.',
    ask: '20 minutes about the role.',
    skipByDefault: false,
  },
  warm_other: {
    recipient: 'contact',
    goal: 'They know you but are not on the hiring team. Ask for a coffee chat or an intro to the hiring manager.',
    ask: 'A quick chat, or an intro to the hiring manager.',
    skipByDefault: false,
  },
  bridge: {
    recipient: 'via',
    goal: 'Write to the mutual connection, not the target. Ask for an intro and include a short forwardable blurb about you and the role.',
    ask: 'Would you forward a short note? Blurb below.',
    skipByDefault: false,
  },
  cold_hiring: {
    recipient: 'contact',
    goal: 'They do not know you and are on the hiring team. Positioning note: their problem, one proof, one ask.',
    ask: 'Open to a short call?',
    skipByDefault: false,
  },
  cold_other: {
    recipient: 'contact',
    goal: 'Cold, not on the hiring team. Only drafted when the user asks.',
    ask: 'Any pointer to the right person?',
    skipByDefault: true,
  },
};

export interface DraftContext {
  tier: ContactTier;
  contact: { name: string; headline: string | null };
  via: { name: string; headline: string | null } | null;
  /** `jd`: the role markdown body (JD section when present), trimmed. CONTEXT. */
  role: { title: string; jd?: string | null };
  /** `dossier`: highlights of the company dossier (snapshot, why, hooks), trimmed. CONTEXT. */
  company: { name: string; dossier?: string | null };
  /** Story component: data_json + markdown text. The only source of facts about the user. */
  story: { data: Record<string, unknown>; text: string };
  /** Voice component: data_json (style, rules, samples, signoff) + markdown text (notes). */
  voice: { data: Record<string, unknown>; text: string };
}

/** Prompt budget for each CONTEXT block. */
export const JD_MAX_CHARS = 2000;
export const DOSSIER_MAX_CHARS = 1500;

const firstName = (n: string): string => n.trim().split(/\s+/)[0] ?? n;

const trimTo = (s: string, max: number): string => {
  const t = s.trim().replace(/\n{3,}/g, '\n\n');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
  return `${(at > max * 0.6 ? cut.slice(0, at + 1) : cut).trimEnd()} [...]`;
};

/** `## Heading` sections of a markdown body (frontmatter already stripped). */
function sections(md: string): Array<{ head: string; body: string }> {
  return md
    .split(/^## /m)
    .slice(1)
    .map((part) => {
      const nl = part.indexOf('\n');
      return nl < 0 ? { head: part.trim(), body: '' } : { head: part.slice(0, nl).trim(), body: part.slice(nl + 1).trim() };
    });
}

/** The JD from a role markdown body: its JD / description section, else the whole body; trimmed. */
export function jdExcerpt(md: string | null | undefined, max = JD_MAX_CHARS): string | null {
  if (!md?.trim()) return null;
  const jd = sections(md).find((s) => /^(jd|job description|description|about the role|the role)$/i.test(s.head));
  const text = jd?.body || md.replace(/^# .*\n?/m, '').trim();
  return text ? trimTo(text, max) : null;
}

const DOSSIER_HIGHLIGHTS = /snapshot|overview|basics|what they do|why|hook|fit|news|current|trajectory|product/i;

/** Dossier highlights: snapshot, why / hooks, news sections (in order), else the start; trimmed. */
export function dossierHighlights(md: string | null | undefined, max = DOSSIER_MAX_CHARS): string | null {
  if (!md?.trim()) return null;
  const picked = sections(md).filter((s) => DOSSIER_HIGHLIGHTS.test(s.head) && s.body);
  const text = picked.length ? picked.map((s) => `${s.head}:\n${s.body}`).join('\n\n') : md.replace(/^# .*\n?/m, '').trim();
  return text ? trimTo(text, max) : null;
}

/** Voice writing samples (data_json.samples), non-empty strings only. */
export const voiceSamples = (voice: DraftContext['voice']): string[] =>
  Array.isArray(voice.data.samples)
    ? (voice.data.samples as unknown[]).filter((s): s is string => typeof s === 'string' && s.trim() !== '').map((s) => s.trim())
    : [];

/** voice.md without its Samples section (samples are passed separately, as exemplars). */
export const voiceNotes = (text: string): string =>
  text
    .replace(/^# Voice\s*$/m, '')
    .replace(/^## Samples\s*\n[\s\S]*?(?=^## |(?![\s\S]))/m, '')
    .trim();

/** The user's name from Story (`name`, or `contact.name`), if the profile has it. */
export function userName(story: DraftContext['story']): string | null {
  const d = story.data;
  if (typeof d.name === 'string' && d.name.trim()) return d.name.trim();
  const c = d.contact as Record<string, unknown> | undefined;
  return c && typeof c.name === 'string' && c.name.trim() ? c.name.trim() : null;
}

const STORY_KEYS = ['name', 'headline', 'years', 'summary', 'wins', 'roles', 'stories', 'skills', 'recognition'] as const;

/** Story facts for the prompt: the markdown plus the structured fields that carry facts. */
function storyBlock(story: DraftContext['story']): string {
  const facts = Object.fromEntries(STORY_KEYS.filter((k) => story.data[k] !== undefined).map((k) => [k, story.data[k]]));
  return (
    [story.text.trim(), Object.keys(facts).length ? `Structured: ${JSON.stringify(facts)}` : ''].filter(Boolean).join('\n\n') || '(empty)'
  );
}

function voiceBlock(voice: DraftContext['voice']): string {
  const d = voice.data;
  const lines: string[] = [];
  if (typeof d.style === 'string') lines.push(`Style: ${d.style}`);
  if (Array.isArray(d.rules) && d.rules.length) lines.push(`Rules: ${(d.rules as unknown[]).join('; ')}`);
  if (typeof d.signoff === 'string') lines.push(`Sign-off: ${JSON.stringify(d.signoff)}`);
  const notes = voiceNotes(voice.text);
  if (notes) lines.push(`Notes:\n${notes}`);
  return lines.join('\n') || '(none)';
}

/** Prompt for the LLM writer. CONTEXT may shape the Hook; facts about the user come only from STORY. */
export function buildWriterPrompt(c: DraftContext): WriterPrompt {
  const t = TIER_TEMPLATES[c.tier];
  const recipient = t.recipient === 'via' && c.via ? c.via : c.contact;
  const signoff = defaultSignoff(c.voice.data, userName(c.story));
  const system = [
    'You write short outreach emails in the user’s voice. They must read like a real email from a person.',
    'Return JSON: {"subject","hook","proof","ask","signoff"}.',
    `Hook: open with a greeting to ${firstName(recipient.name)} (e.g. "Hi ${firstName(recipient.name)},"), then one or two lines about their world, drawn from CONTEXT (the role, the team, the company).`,
    `Proof: two or three sentences (max ${PROOF_MAX_SENTENCES}), first person, taken only from STORY. Tie them to what the role needs. No numbers that are not in STORY.`,
    'Ask: one small, specific ask (the close).',
    `Signoff: in the user’s voice; default ${JSON.stringify(signoff)}.`,
    'Sources: CONTEXT is facts about them (usable for the hook). STORY is the ONLY source of facts about the user. VOICE and SAMPLES set tone only.',
    'Samples: match their tone, rhythm and phrasing; never reuse facts, names or numbers from samples.',
    'Rules: no em dashes, no en dashes; punchy (hook, reframe, close); no flattery; no facts beyond STORY; never invent metrics.',
    `Limits: subject ${LIMITS.subject} chars, hook ${LIMITS.hook}, proof ${LIMITS.proof}, ask ${c.tier === 'bridge' ? BRIDGE_ASK_MAX : LIMITS.ask}, signoff ${LIMITS.signoff}.`,
  ].join('\n');
  const samples = voiceSamples(c.voice);
  const user = [
    `TIER: ${c.tier}`,
    `GOAL: ${t.goal}`,
    `DEFAULT ASK: ${t.ask}`,
    `RECIPIENT: ${t.recipient === 'via' && c.via ? `${c.via.name} (${c.via.headline ?? 'connection'}), mutual of ${c.contact.name}` : `${c.contact.name} (${c.contact.headline ?? 'unknown'})`}`,
    [
      'CONTEXT (facts about them; usable for the hook, never as facts about the user):',
      `Target: ${c.contact.name}${c.contact.headline ? `, ${c.contact.headline}` : ''}`,
      `Role: ${c.role.title} at ${c.company.name}`,
      `JD:\n${c.role.jd ?? '(none on file)'}`,
      `Company dossier:\n${c.company.dossier ?? '(none on file)'}`,
    ].join('\n'),
    `STORY (the only source of facts about the user):\n${storyBlock(c.story)}`,
    `VOICE (style and notes):\n${voiceBlock(c.voice)}`,
    samples.length
      ? `SAMPLES (style exemplars; match tone, rhythm and phrasing; never reuse their facts):\n${samples.map((s, i) => `[${i + 1}]\n${s}`).join('\n\n')}`
      : 'SAMPLES: (none)',
  ].join('\n\n');
  return { tier: c.tier, system, user };
}

const DASH = /—|–|\s--\s/;
const PAST = /^(?:[A-Z][a-z]+ed|Built|Led|Ran|Grew|Cut|Won|Made|Took|Drove|Set|Shipped|Sold|Wrote|Rebuilt|Brought)\b/;

/** A Story win in first person: "Launched X" -> "I launched X." Never adds facts. */
const firstPerson = (w: string): string => {
  const s = w.trim().replace(/\.$/, '');
  return `${PAST.test(s) ? `I ${s.charAt(0).toLowerCase()}${s.slice(1)}` : s}.`;
};

const storyWins = (story: DraftContext['story']): string[] =>
  Array.isArray(story.data.wins)
    ? (story.data.wins as unknown[]).filter((w): w is string => typeof w === 'string' && w.trim() !== '' && !DASH.test(w))
    : [];

/** First Story win (first person), else the headline. Never invents. */
export function storyProof(story: DraftContext['story']): string {
  const win = storyWins(story)[0];
  if (win) return firstPerson(win);
  const headline = typeof story.data.headline === 'string' ? story.data.headline : null;
  return headline ? `${headline.replace(/\.$/, '')}.` : 'My background is in the Story on file.';
}

/** Two Story wins when there are two, else one (two sentences max). */
function proofFrom(story: DraftContext['story']): string {
  const wins = storyWins(story);
  if (wins.length < 2) return storyProof(story);
  const second = firstPerson(wins[1] as string).replace(/^I /, 'I also ');
  const two = `${firstPerson(wins[0] as string)} ${second}`;
  return two.length <= LIMITS.proof ? two : storyProof(story);
}

const OWN = /^(?:you will |you'll |you )?((?:own|lead|build|drive|shape|define|scale|grow|ship|run|set)\b[^.!?\n]{10,140})[.!?]/i;

/** One theme from the JD ("own the roadmap for ..."), quoted from CONTEXT, or null. */
export function jdTheme(jd: string | null | undefined): string | null {
  if (!jd) return null;
  for (const raw of jd.split(/(?<=[.!?])\s+|\n+/)) {
    const m = raw
      .trim()
      .replace(/^[-*]\s*/, '')
      .match(OWN);
    const theme = m?.[1]?.trim();
    if (theme && !DASH.test(theme)) return `${theme.charAt(0).toLowerCase()}${theme.slice(1)}`;
  }
  return null;
}

/** Deterministic natural-shape draft from the tier template + CONTEXT + STORY. Dry runs and no-writer runs. */
export function templateDraft(c: DraftContext): DraftText {
  const t = TIER_TEMPLATES[c.tier];
  const co = c.company.name;
  const role = c.role.title;
  const theme = jdTheme(c.role.jd);
  const proof = proofFrom(c.story);
  const signoff = defaultSignoff(c.voice.data, userName(c.story));
  const hi = `Hi ${firstName(c.contact.name)},`;
  const about = theme ? ` The JD puts it plainly: ${theme}.` : '';
  /** The Hook with the JD theme when it fits the limit, else without. */
  const fit = (withTheme: string, plain: string) => (theme && withTheme.length <= LIMITS.hook ? withTheme : plain);
  switch (c.tier) {
    case 'warm_hiring':
      return {
        subject: `${role} at ${co}`,
        hook: fit(`${hi} I saw the ${role} opening on your team.${about}`, `${hi} I saw the ${role} opening on your team.`),
        proof,
        ask: `Up for ${t.ask.toLowerCase().replace(/\.$/, '')} next week?`,
        signoff,
      };
    case 'warm_other':
      return {
        subject: `Quick question about ${co}`,
        hook: fit(
          `${hi} ${co} is hiring a ${role}, and it fits what I do.${about}`,
          `${hi} ${co} is hiring a ${role}, and it fits what I do.`,
        ),
        proof,
        ask: 'Coffee this week, or a pointer to the hiring manager?',
        signoff,
      };
    case 'bridge': {
      const via = c.via ? firstName(c.via.name) : 'there';
      return {
        subject: `Intro to ${c.contact.name}?`,
        hook: `Hi ${via}, you know ${c.contact.name} at ${co}, and their team is hiring a ${role}.`,
        proof,
        ask: `Would you forward a short note? Blurb: "${role} candidate. ${storyProof(c.story)} Happy to share more."`,
        signoff,
      };
    }
    case 'cold_hiring':
      return {
        subject: `${role}: one idea for ${co}`,
        hook: fit(
          `${hi} the ${role} role asks someone to ${theme}. That is the problem I like to own.`,
          `${hi} the ${role} role reads like a bet on getting more from your data.`,
        ),
        proof,
        ask: t.ask,
        signoff,
      };
    case 'cold_other':
      return {
        subject: `${role} at ${co}`,
        hook: fit(`${hi} I am looking at the ${role} role at ${co}.${about}`, `${hi} I am looking at the ${role} role at ${co}.`),
        proof,
        ask: t.ask,
        signoff,
      };
  }
}
