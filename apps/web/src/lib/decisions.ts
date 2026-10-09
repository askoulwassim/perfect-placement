import type { Decision, DecisionKind, EmailVerification, EmailVerifyStatus } from '@perfect-placement/contracts';
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
  'apply.fact_check': 'Keep this claim?',
  'people.email': 'Use this email?',
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
  // #37: addresses show as written.
  if (kind === 'people.email' && typeof v === 'string' && v !== 'other') return v;
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

/** An `apply.fact_check` question (#54): the claim, where it is, and the closest source line. */
export interface FactCheckQ {
  claim: string;
  doc: 'resume' | 'cover_letter' | 'answers';
  line: string;
  source: string | null;
}
export const factCheckOf = (d: Pick<Decision, 'kind' | 'question_json'>): FactCheckQ | null => {
  if (d.kind !== 'apply.fact_check') return null;
  const q = d.question_json as Partial<FactCheckQ>;
  return typeof q.claim === 'string' && typeof q.line === 'string'
    ? { claim: q.claim, doc: q.doc ?? 'resume', line: q.line, source: q.source ?? null }
    : null;
};
export const DOC_NAME: Record<FactCheckQ['doc'], string> = { resume: 'Resume', cover_letter: 'Cover letter', answers: 'Answers' };

/** Short label per email check result (#99). */
export const VERIFY_LABEL: Record<EmailVerifyStatus, string> = {
  deliverable: 'Deliverable',
  risky: 'Risky',
  undeliverable: 'Undeliverable',
  catch_all: 'Catch-all',
  unknown: 'Unknown',
};

/** A `people.email` question (#37): whose address, the domain, its MX check and the learned format. */
export interface EmailQ {
  name: string;
  domain: string;
  mx: boolean | null;
  pattern: string | null;
  examples: number;
  /** #99: each candidate's email check (MX only when no provider answered). */
  checks: Record<string, EmailVerification>;
}

/** "Catch-all · Hunter", "Unknown · MX ok", "Unknown · no MX" (#99). */
export function checkLabel(v: EmailVerification | undefined): string | null {
  if (!v) return null;
  const by = v.provider ? cap(v.provider) : v.mx === true ? 'MX ok' : v.mx === false ? 'no MX' : null;
  return by ? `${VERIFY_LABEL[v.status]} · ${by}` : VERIFY_LABEL[v.status];
}
const cap = (s: string) =>
  ({ neverbounce: 'NeverBounce', zerobounce: 'ZeroBounce', hunter: 'Hunter' })[s] ?? s.replace(/^./, (c) => c.toUpperCase());
export const emailOf = (d: Pick<Decision, 'kind' | 'question_json'>): EmailQ | null => {
  if (d.kind !== 'people.email') return null;
  const q = d.question_json as Partial<EmailQ>;
  return typeof q.domain === 'string'
    ? {
        name: q.name ?? '',
        domain: q.domain,
        mx: q.mx ?? null,
        pattern: q.pattern ?? null,
        examples: q.examples ?? 0,
        checks: Object.fromEntries(
          ((q as { candidates?: Array<{ email: string; verify?: EmailVerification }> }).candidates ?? []).flatMap((c) =>
            c.verify ? [[c.email, c.verify]] : [],
          ),
        ),
      }
    : null;
};
