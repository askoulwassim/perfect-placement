import type { ContactTier } from '@perfect-placement/contracts';
import type { DraftText, WriterPrompt } from './types.js';

/*
 * Draft templates per tier (blueprint.md "Connect"). Every draft is Hook / Proof / Ask:
 *   Hook  = their world, one line (reframe what they care about)
 *   Proof = one fact from Story, numbers only if Story has them
 *   Ask   = one small, specific ask (the close)
 * Text comes from the LLM writer; `templateDraft` is a deterministic fallback for dry runs and tests.
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
  role: { title: string };
  company: { name: string };
  /** Story component: data_json + markdown text. */
  story: { data: Record<string, unknown>; text: string };
  /** Voice component: data_json + markdown text. */
  voice: { data: Record<string, unknown>; text: string };
}

const firstName = (n: string): string => n.split(/\s+/)[0] ?? n;

/** Prompt for the LLM writer. Grounded only in Story and Voice; the writer must not add facts. */
export function buildWriterPrompt(c: DraftContext): WriterPrompt {
  const t = TIER_TEMPLATES[c.tier];
  const system = [
    'You write short outreach emails in the user’s voice.',
    'Return JSON: {"subject","hook","proof","ask"}.',
    'Hook: one line about their world. Proof: one fact taken from STORY, no new numbers. Ask: one small, specific ask.',
    'Rules: no em dashes, no en dashes; punchy (hook, reframe, close); no flattery; no facts beyond STORY.',
    `Limits: subject 80 chars, hook 280, proof 400, ask ${c.tier === 'bridge' ? 560 : 240}.`,
  ].join('\n');
  const user = [
    `TIER: ${c.tier}`,
    `GOAL: ${t.goal}`,
    `DEFAULT ASK: ${t.ask}`,
    `RECIPIENT: ${t.recipient === 'via' && c.via ? `${c.via.name} (${c.via.headline ?? 'connection'}), mutual of ${c.contact.name}` : `${c.contact.name} (${c.contact.headline ?? 'unknown'})`}`,
    `TARGET: ${c.contact.name}, ${c.contact.headline ?? ''}`.trim(),
    `ROLE: ${c.role.title} at ${c.company.name}`,
    `STORY:\n${c.story.text || JSON.stringify(c.story.data)}`,
    `VOICE:\n${c.voice.text || JSON.stringify(c.voice.data)}`,
  ].join('\n\n');
  return { tier: c.tier, system, user };
}

/** First Story win, else the headline. Never invents. */
export function storyProof(story: DraftContext['story']): string {
  const wins = Array.isArray(story.data.wins) ? (story.data.wins as unknown[]).filter((w): w is string => typeof w === 'string') : [];
  if (wins[0]) return `${wins[0].replace(/\.$/, '')}.`;
  const headline = typeof story.data.headline === 'string' ? story.data.headline : null;
  return headline ? `${headline}.` : 'My background is in the Story on file.';
}

/** Deterministic Hook / Proof / Ask from the tier template. Used in dry runs and when no writer is wired. */
export function templateDraft(c: DraftContext): DraftText {
  const t = TIER_TEMPLATES[c.tier];
  const co = c.company.name;
  const proof = storyProof(c.story);
  switch (c.tier) {
    case 'warm_hiring':
      return {
        subject: `${c.role.title} at ${co}`,
        hook: `Hi ${firstName(c.contact.name)}, saw the ${c.role.title} opening on your team.`,
        proof,
        ask: `Up for ${t.ask.toLowerCase().replace(/\.$/, '')} next week?`,
      };
    case 'warm_other':
      return {
        subject: `Quick question about ${co}`,
        hook: `Hi ${firstName(c.contact.name)}, ${co} is hiring a ${c.role.title} and it fits what I do.`,
        proof,
        ask: 'Coffee chat this week, or a pointer to the hiring manager?',
      };
    case 'bridge': {
      const via = c.via ? firstName(c.via.name) : 'there';
      return {
        subject: `Intro to ${c.contact.name}?`,
        hook: `Hi ${via}, you know ${c.contact.name} at ${co}, and they are hiring a ${c.role.title}.`,
        proof,
        ask: `Would you forward a short note? Blurb: "${c.role.title} candidate. ${proof} Happy to share more."`,
      };
    }
    case 'cold_hiring':
      return {
        subject: `${c.role.title}: one idea for ${co}`,
        hook: `Hi ${firstName(c.contact.name)}, the ${c.role.title} role reads like a bet on getting more from your data.`,
        proof,
        ask: t.ask,
      };
    case 'cold_other':
      return {
        subject: `${c.role.title} at ${co}`,
        hook: `Hi ${firstName(c.contact.name)}, I am looking at the ${c.role.title} role at ${co}.`,
        proof,
        ask: t.ask,
      };
  }
}
