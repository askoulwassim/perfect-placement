import type { DraftText } from './types.js';

/*
 * Mechanical checks on outreach text. The LLM writes; code refuses what breaks the rules:
 * - no em dashes (and no en dash or double hyphen standing in for one)
 * - punchy: each block short, subject short
 * - grounded: every number in the Proof must appear in the Story (no invented metrics)
 */

export interface StyleIssue {
  field: keyof DraftText;
  rule: 'em_dash' | 'too_long' | 'empty' | 'ungrounded_number';
  detail: string;
}

export const LIMITS: Record<keyof DraftText, number> = { subject: 80, hook: 280, proof: 400, ask: 240 };

const DASHES = /\u2014|\u2013|\s--\s/;

const numbersIn = (s: string): string[] => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(',', ''));

/** Bridge asks carry a forwardable blurb, so they get more room. */
export const BRIDGE_ASK_MAX = 560;

export function checkDraft(d: DraftText, storyText: string, opts: { bridge?: boolean } = {}): StyleIssue[] {
  const issues: StyleIssue[] = [];
  for (const field of Object.keys(LIMITS) as Array<keyof DraftText>) {
    const v = d[field] ?? '';
    const max = field === 'ask' && opts.bridge ? BRIDGE_ASK_MAX : LIMITS[field];
    if (!v.trim()) issues.push({ field, rule: 'empty', detail: 'empty' });
    if (DASHES.test(v)) issues.push({ field, rule: 'em_dash', detail: 'no em dashes' });
    if (v.length > max) issues.push({ field, rule: 'too_long', detail: `${v.length} > ${max}` });
  }
  const storyNums = new Set(numbersIn(storyText));
  for (const n of numbersIn(d.proof)) {
    if (!storyNums.has(n)) issues.push({ field: 'proof', rule: 'ungrounded_number', detail: `"${n}" is not in Story` });
  }
  return issues;
}

/** Plain-text body for Gmail: Hook, Proof, Ask as three short paragraphs. */
export const composeBody = (d: Pick<DraftText, 'hook' | 'proof' | 'ask'>): string =>
  `${d.hook.trim()}\n\n${d.proof.trim()}\n\n${d.ask.trim()}\n`;
