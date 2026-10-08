import type { Decision, DecisionKind } from '@perfect-placement/contracts';
import { humanize } from './format';

/** The question in five words or fewer, per decision kind. */
export const SHORT_Q: Record<DecisionKind, string> = {
  'freshness.closed': 'Is this posting open?',
  'inbox.classify': 'What is this reply?',
  'roles.dedupe': 'Same job?',
  'roles.criterion': 'Score this?',
  'roles.move': 'Move this role?',
  'roles.archive': 'Archive this role?',
  'profile.learn': 'Learn this?',
  'profile.apply_diff': 'Apply this change?',
  'people.classify': 'Who is this?',
  'outreach.to_gmail': 'Create the Gmail draft?',
  'apply.submit': 'Submit this application?',
  other: 'Your call?',
};

export type DecisionObject = 'role' | 'mail' | 'profile' | 'contact';
export const objectOf = (d: Pick<Decision, 'kind' | 'subject_type'>): DecisionObject =>
  d.kind === 'inbox.classify'
    ? 'mail'
    : d.subject_type === 'profile_diff' || d.subject_type === 'profile'
      ? 'profile'
      : d.subject_type === 'contact' || d.subject_type === 'outreach'
        ? 'contact'
        : 'role';

const BOOL_LABELS: Partial<Record<DecisionKind, [string, string]>> = {
  'freshness.closed': ['Still open', 'Closed'],
  'profile.apply_diff': ['Apply', 'Keep'],
  'outreach.to_gmail': ['Create', 'Hold'],
  'apply.submit': ['Package ready', 'Hold'],
  'roles.dedupe': ['Same', 'New'],
};

export function valueLabel(kind: DecisionKind, v: unknown): string {
  if (typeof v === 'boolean') {
    const [y, n] = BOOL_LABELS[kind] ?? ['Yes', 'No'];
    return v ? y : n;
  }
  return typeof v === 'string' ? humanize(v) : String(v);
}

export const pickOf = (d: Pick<Decision, 'answer_json'>) => (d.answer_json as { value?: string | boolean | number }).value;

export function altsOf(d: Pick<Decision, 'question_json' | 'answer_json'>): Array<string | boolean | number> {
  const q = d.question_json as { type?: string; options?: string[]; min?: number; max?: number };
  const pick = pickOf(d);
  let all: Array<string | boolean | number> = [];
  if (q.type === 'noulli') all = [true, false];
  else if (q.type === 'choice') all = q.options ?? [];
  else if (q.type === 'score') for (let i = q.min ?? 1; i <= (q.max ?? 5); i++) all.push(i);
  return all.filter((v) => v !== pick);
}
