import {
  type Answer,
  type AskFn,
  type AskRequest,
  type Backend,
  type BackendResult,
  CRITERIA,
  type Criterion,
  type RecordRequest,
  type RecordResult,
} from '@perfect-placement/contracts';
import { type BrandInput, type CriterionSource, criterionRequests, judgeCriteria, type RoleForJudging } from './blind.js';

/*
 * Scoring through the decision layer (#40). Two paths, both leave one decision row per criterion:
 * - resolver: no criteria supplied. Two asks per role (blind state for C1 C2 C3 C4 C9, full state for
 *   C5..C8; one Kev call each), routed rule -> Kev -> agent -> human.
 * - agent: the agent judged C1..C9. Each is recorded as an `agent` decision; Kev, when it answers,
 *   gives a second opinion on the same blind / open states and gaps over one point are flagged.
 */

/** A gap above this many points between the agent and Kev is flagged on the score and the Role screen. */
export const DISAGREE_POINTS = 1;
/** The agent's p for a criterion when it states none (neither `confidence` nor `ctx.confidence`). */
export const AGENT_DEFAULT_P = 0.75;

export interface Disagreement {
  criterion: Criterion;
  agent: number;
  kev: number;
  kev_p: number;
}

/** Keys the judge adds to `score.facts_json`. */
export interface JudgeFacts {
  criteria_source: Record<Criterion, CriterionSource>;
  /** Agent path only: `kev` when Kev answered, else `unavailable`. */
  second_opinion?: 'kev' | 'unavailable';
  disagreements?: Disagreement[];
}

export interface JudgeDeps {
  ask: AskFn;
  record(
    req: RecordRequest,
    opts?: { second?: { backend: Backend; value: Answer['value']; p: number }; extra?: Record<string, unknown> },
  ): Promise<RecordResult>;
  /** One backend, no decision row (second opinion). */
  consult(backend: 'kev', req: AskRequest): Promise<BackendResult | undefined>;
}

export type JudgeResult =
  | { kind: 'judged'; criteria: Record<Criterion, number>; facts: JudgeFacts }
  /** No model answered: the criteria are in Needs you. */
  | { kind: 'human'; decision_ids: string[]; pending: Criterion[] };

/** Path 1: the resolver judges C1..C9. */
export async function judgeThroughResolver(
  deps: Pick<JudgeDeps, 'ask'>,
  role: RoleForJudging,
  brand: BrandInput,
  profileSummary: string,
): Promise<JudgeResult> {
  const r = await judgeCriteria(deps.ask, role, brand, profileSummary);
  const pending = CRITERIA.filter((c) => r.sources[c].backend === 'human');
  if (pending.length) return { kind: 'human', decision_ids: pending.map((c) => r.sources[c].decision_id), pending };
  return { kind: 'judged', criteria: r.criteria, facts: { criteria_source: r.sources } };
}

/** Path 2: the agent's criteria, recorded per criterion, with Kev's second opinion when it answers. */
export async function recordAgentCriteria(
  deps: JudgeDeps,
  role: RoleForJudging,
  brand: BrandInput,
  profileSummary: string,
  criteria: Record<Criterion, number>,
  confidence: Partial<Record<Criterion, number>>,
  defaultP: number,
): Promise<JudgeResult> {
  const reqs = criterionRequests(role, brand, profileSummary);
  const seconds = await Promise.all(reqs.map((r) => deps.consult('kev', r).catch(() => undefined)));
  const kev = new Map<string, Answer>();
  for (const s of seconds) for (const a of s?.answers ?? []) kev.set(a.id, a);

  const sources = {} as Record<Criterion, CriterionSource>;
  const disagreements: Disagreement[] = [];
  for (const req of reqs) {
    for (const q of req.questions) {
      const c = q.id as Criterion;
      const value = criteria[c];
      const p = confidence[c] ?? defaultP;
      const k = kev.get(c);
      const disagree = k !== undefined && Math.abs(Number(k.value) - value) > DISAGREE_POINTS;
      if (k && disagree) disagreements.push({ criterion: c, agent: value, kev: Number(k.value), kev_p: k.p });
      const { decisionId } = await deps.record(
        {
          decision: req.decision,
          impact: req.impact,
          subject: req.subject ?? { type: 'role', id: role.role_id },
          question: { ...q, state: req.state },
          answer: { id: c, value, p },
          backend: 'agent',
        },
        {
          ...(k ? { second: { backend: 'kev' as const, value: k.value, p: k.p } } : {}),
          ...(disagree ? { extra: { disagree: true } } : {}),
        },
      );
      sources[c] = { backend: 'agent', p, decision_id: decisionId, latency_ms: 0 };
    }
  }
  const answered = seconds.every((s) => s !== undefined);
  return {
    kind: 'judged',
    criteria,
    facts: { criteria_source: sources, second_opinion: answered ? 'kev' : 'unavailable', disagreements },
  };
}

/** A short candidate summary for the open criteria (C5..C8) from profile component data. */
export function profileSummaryOf(components: ReadonlyArray<{ key: string; data_json: Record<string, unknown> }>, max = 2000): string {
  const keys = ['craft', 'domain', 'team', 'growth', 'terms', 'work_mode', 'dealbreakers'];
  const lines = components
    .filter((c) => keys.includes(c.key))
    .sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key))
    .map((c) => `${c.key}: ${JSON.stringify(c.data_json)}`);
  const text = lines.join('\n');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
