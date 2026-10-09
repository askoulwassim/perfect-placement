import type { DraftText } from './types.js';

/*
 * Mechanical checks on outreach text. The LLM (or the agent) writes; code refuses what breaks the rules:
 * - no em dashes (and no en dash or double hyphen standing in for one)
 * - short: each block has a limit, the Proof is at most three sentences
 * - grounded: every number in the Proof must appear in STORY; a number in the Hook must appear in STORY
 *   or CONTEXT (the JD and dossier); no invented metrics
 * - no flattery (a short list of stock phrases)
 */

export interface StyleIssue {
  field: keyof DraftText;
  rule: 'em_dash' | 'too_long' | 'empty' | 'ungrounded_number' | 'too_many_sentences' | 'flattery';
  detail: string;
}

/** Per-block limits. The Hook carries the greeting; the Proof may be two or three sentences. */
export const LIMITS: Record<keyof DraftText, number> = { subject: 80, hook: 320, proof: 560, ask: 240, signoff: 80 };

/** Bridge asks carry a forwardable blurb, so they get more room. */
export const BRIDGE_ASK_MAX = 560;

/** The Proof is two or three sentences at most. */
export const PROOF_MAX_SENTENCES = 3;

const DASHES = /—|–|\s--\s/;

const FLATTERY =
  /\b(huge|big) fan\b|\bi (really |truly )?admire\b|\b(amazing|incredible|awesome|impressive|inspiring) (work|team|company|product|journey)\b/i;

const numbersIn = (s: string): string[] => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', ''));

/** Sentences in a block (ignores decimals and common abbreviations like "e.g."). */
export const sentenceCount = (s: string): number =>
  s
    .replace(/\b(e\.g|i\.e|etc|vs|Mr|Ms|Dr)\./gi, '$1')
    .replace(/(\d)\.(\d)/g, '$1$2')
    .split(/[.!?]+(?:\s+|$)/)
    .filter((x) => x.trim()).length;

export interface CheckOptions {
  bridge?: boolean;
  /** CONTEXT text (JD, dossier, contact headline): numbers in the Hook may come from here. */
  context?: string;
}

export function checkDraft(d: DraftText, storyText: string, opts: CheckOptions = {}): StyleIssue[] {
  const issues: StyleIssue[] = [];
  for (const field of Object.keys(LIMITS) as Array<keyof DraftText>) {
    const v = d[field];
    if (field === 'signoff' && v === undefined) continue;
    const text = v ?? '';
    const max = field === 'ask' && opts.bridge ? BRIDGE_ASK_MAX : LIMITS[field];
    if (!text.trim()) issues.push({ field, rule: 'empty', detail: 'empty' });
    if (DASHES.test(text)) issues.push({ field, rule: 'em_dash', detail: 'no em dashes' });
    if (text.length > max) issues.push({ field, rule: 'too_long', detail: `${text.length} > ${max}` });
    if (field !== 'subject' && FLATTERY.test(text)) issues.push({ field, rule: 'flattery', detail: 'no flattery' });
  }
  const n = sentenceCount(d.proof);
  if (n > PROOF_MAX_SENTENCES) issues.push({ field: 'proof', rule: 'too_many_sentences', detail: `${n} > ${PROOF_MAX_SENTENCES}` });
  const storyNums = new Set(numbersIn(storyText));
  for (const x of numbersIn(d.proof)) {
    if (!storyNums.has(x)) issues.push({ field: 'proof', rule: 'ungrounded_number', detail: `"${x}" is not in Story` });
  }
  const known = new Set([...storyNums, ...numbersIn(opts.context ?? '')]);
  for (const x of numbersIn(d.hook)) {
    if (!known.has(x)) issues.push({ field: 'hook', rule: 'ungrounded_number', detail: `"${x}" is not in Story or the role context` });
  }
  return issues;
}

const firstName = (n: string): string => n.trim().split(/\s+/)[0] ?? n;

/** A greeting at the start of the Hook: "Hi Maya," / "Hello Dev," / "Hey there,". */
const GREETING = /^((?:hi|hello|hey|dear|good (?:morning|afternoon))\b[^,.!?\n]{0,40},)\s*/i;

export function splitGreeting(hook: string): { greeting: string | null; rest: string } {
  const h = hook.trim();
  const m = h.match(GREETING);
  if (!m?.[1]) return { greeting: null, rest: h };
  const rest = h.slice(m[0].length).trim();
  // The rest of the Hook opens its own paragraph: capitalize its first letter.
  return { greeting: m[1], rest: rest.charAt(0).toUpperCase() + rest.slice(1) };
}

/** Default sign-off: Voice `signoff`, else "Thanks," plus the user's first name when the profile has it. */
export function defaultSignoff(voice: Record<string, unknown>, userName: string | null): string {
  if (typeof voice.signoff === 'string' && voice.signoff.trim()) return voice.signoff.trim();
  return userName ? `Thanks,\n${firstName(userName)}` : 'Thanks,';
}

/**
 * Plain-text Gmail body as a natural email:
 *   greeting line (from the Hook, else "Hi <first name>,"), blank line,
 *   the rest of the Hook, blank line, Proof, blank line, Ask, blank line, sign-off.
 */
export function composeBody(
  d: Pick<DraftText, 'hook' | 'proof' | 'ask' | 'signoff'>,
  opts: { recipientName?: string | null } = {},
): string {
  const { greeting, rest } = splitGreeting(d.hook);
  const hello = greeting ?? (opts.recipientName ? `Hi ${firstName(opts.recipientName)},` : 'Hi,');
  const paras = [hello, rest, d.proof.trim(), d.ask.trim()].filter(Boolean);
  const signoff = d.signoff?.trim();
  return `${paras.join('\n\n')}\n${signoff ? `\n${signoff}\n` : ''}`;
}
