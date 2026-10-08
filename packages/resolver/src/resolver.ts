import {
  type Actor,
  type Answer,
  AskRequest,
  type AskResult,
  type Backend,
  type BackendResult,
  type Decision,
  type DecisionBackend,
  type Impact,
  type PolicyConfig,
  type PolicyOutcome,
  type Question,
  RecordRequest,
  type RecordResult,
  type Resolver,
  type RunOp,
  SUBJECT_TYPES,
  type SubjectType,
  type Thresholds,
} from '@perfect-placement/contracts';
import { actionApplies, type DecisionAction, substituteValue } from './actions.js';
import { createHumanBackend } from './backends/human.js';
import type { RuleBackend } from './backends/rule.js';
import { BackendUnavailableError } from './errors.js';
import { newDecisionId, newEventId } from './ids.js';
import { decide as decidePolicy, effectiveImpact, effectiveThresholds, finalOutcome, secondOpinionAgrees, undoUntil } from './policy.js';
import type { DecisionStore } from './store.js';

export type BackendMap = Partial<Record<Exclude<Backend, 'human' | 'rule'>, DecisionBackend>> & { rule?: RuleBackend };

export interface ResolverDeps {
  config: PolicyConfig;
  backends: BackendMap;
  /** Decisions log. Every ask writes one row per answer. */
  store: DecisionStore;
  /** Executes `action_json` for auto outcomes. Without it, the caller applies auto outcomes itself. */
  runOp?: RunOp;
  now?: () => Date;
  newId?: () => string;
  /** Called on each backend failure before falling back (logging, health UI). */
  onFallback?: (backend: Backend, err: unknown) => void;
}

export interface AskOptions {
  /** Per question id: the op to run when the decision is applied. Stored in `decision.action_json`. */
  actions?: Record<string, DecisionAction>;
  /** Per-call threshold override (on top of config base + per-kind override). */
  thresholds?: Partial<Thresholds>;
  actor?: Actor;
  runId?: string;
}

/** Second-opinion preference: never the primary, never rule/human. Kev is cheap and local, then the LLM. */
const SECOND_ORDER: Exclude<Backend, 'human' | 'rule'>[] = ['kev', 'llm', 'jev'];

function validAnswer(q: Question, a: Answer | undefined): a is Answer {
  if (!a || a.id !== q.id || !(a.p >= 0 && a.p <= 1)) return false;
  switch (q.type) {
    case 'choice':
      return typeof a.value === 'string' && q.options.includes(a.value);
    case 'noulli':
      return typeof a.value === 'boolean';
    case 'score':
      return typeof a.value === 'number' && a.value >= q.min && a.value <= q.max;
  }
}

function subjectOf(req: AskRequest): { type: SubjectType; id: string } {
  const t = req.subject?.type;
  if (t && (SUBJECT_TYPES as readonly string[]).includes(t)) return { type: t as SubjectType, id: req.subject?.id ?? '' };
  return { type: 'system', id: req.subject?.id ?? req.decision };
}

export interface ResolverInstance extends Resolver {
  ask(req: AskRequest, opts?: AskOptions): Promise<AskResult>;
  record(req: RecordRequest, opts?: AskOptions): Promise<RecordResult>;
  /** Backend order this request would try (for Settings + tests). */
  route(req: AskRequest): Backend[];
}

export function createResolver(deps: ResolverDeps): ResolverInstance {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => newDecisionId(now().getTime()));
  const human = createHumanBackend();

  function route(req: AskRequest): Backend[] {
    if (req.backend) return [req.backend];
    if (deps.backends.rule?.canAnswer(req)) return ['rule'];
    const order: Backend[] = [];
    for (const b of [deps.config.backends.default, deps.config.backends.fallback, 'llm'] as const) {
      if (!order.includes(b) && deps.backends[b]) order.push(b);
    }
    return order;
  }

  function backendFor(name: Backend): DecisionBackend | undefined {
    if (name === 'human') return human;
    return deps.backends[name];
  }

  async function tryBackend(name: Backend, req: AskRequest): Promise<BackendResult | undefined> {
    const b = backendFor(name);
    if (!b) return undefined;
    try {
      const res = await b.ask(req);
      const ok = req.questions.every((q) =>
        validAnswer(
          q,
          res.answers.find((a) => a.id === q.id),
        ),
      );
      if (!ok) throw new BackendUnavailableError(name, 'invalid answers');
      // Return answers in question order.
      return { ...res, answers: req.questions.map((q) => res.answers.find((a) => a.id === q.id) as Answer) };
    } catch (err) {
      deps.onFallback?.(name, err);
      return undefined;
    }
  }

  async function secondOpinion(
    primary: Backend,
    req: AskRequest,
    questions: Question[],
  ): Promise<{ backend: Backend; answers: Answer[] } | undefined> {
    if (!questions.length) return undefined;
    const sub: AskRequest = { ...req, questions, backend: undefined };
    for (const name of SECOND_ORDER) {
      if (name === primary || !deps.backends[name]) continue;
      const res = await tryBackend(name, sub);
      if (res) return { backend: name, answers: res.answers };
    }
    return undefined;
  }

  async function runAction(d: Decision, action: DecisionAction, value: Answer['value'], opts: AskOptions): Promise<Decision> {
    if (!deps.runOp || !actionApplies(action, value)) return d;
    const outcome = await deps.runOp(action.op, substituteValue(action.input, value), {
      actor: opts.actor ?? 'agent',
      now,
      decisionId: d.id,
      ...(opts.runId ? { runId: opts.runId } : {}),
    });
    if (outcome.status === 'ok') return d;
    // The action could not run: hand the decision to a human with the pick attached.
    return deps.store.update(d.id, {
      policy_outcome: 'human',
      status: 'pending',
      resolved_at: null,
      undo_until: null,
      answer_json: { ...d.answer_json, action_error: outcome.status === 'error' ? outcome.message : outcome.status },
    });
  }

  async function ask(input: AskRequest, opts: AskOptions = {}): Promise<AskResult> {
    const req = AskRequest.parse(input);
    const impact: Impact = effectiveImpact(req.decision, req.impact);
    const thresholds = effectiveThresholds(deps.config, req.decision, opts.thresholds);
    const started = now().getTime();

    let backend: Backend = 'human';
    let result: BackendResult | undefined;
    for (const name of route(req)) {
      result = await tryBackend(name, req);
      if (result) {
        backend = name;
        break;
      }
    }
    if (!result) result = await human.ask(req);

    const decided = result.answers.map((a) => (backend === 'human' ? ('human' as const) : decidePolicy(a, impact, thresholds)));
    const needSecond = req.questions.filter((_, i) => decided[i] === 'auto_second');
    const second = await secondOpinion(backend, req, needSecond);

    const ts = now();
    const latencyMs = Math.max(0, ts.getTime() - started);
    const subject = subjectOf(req);
    const decisionIds: string[] = [];
    const outcomes: PolicyOutcome[] = [];

    for (const [i, q] of req.questions.entries()) {
      const a = result.answers[i] as Answer & { raw?: unknown };
      const secondAnswer = second?.answers.find((x) => x.id === q.id);
      const agrees = decided[i] === 'auto_second' && secondOpinionAgrees(q, a, secondAnswer);
      const outcome = finalOutcome(decided[i] as PolicyOutcome, agrees);
      const action = opts.actions?.[q.id] ?? req.actions?.[q.id] ?? req.action;
      const answerJson: Record<string, unknown> = { id: a.id, value: a.value, p: a.p };
      if (a.raw !== undefined) answerJson.raw = a.raw;
      if (secondAnswer && second) answerJson.second = { backend: second.backend, value: secondAnswer.value, p: secondAnswer.p };
      const auto = outcome !== 'human';
      let d: Decision = {
        id: newId(),
        ts: ts.toISOString(),
        kind: req.decision,
        subject_type: subject.type,
        subject_id: subject.id,
        question_json: { ...q, state: req.state },
        backend,
        answer_json: answerJson,
        p: a.p,
        impact,
        policy_outcome: outcome,
        status: auto ? 'applied' : 'pending',
        human_choice: null,
        overridden: false,
        undo_until: outcome === 'auto_undo' ? undoUntil(ts, thresholds) : null,
        resolved_at: auto ? ts.toISOString() : null,
        latency_ms: Math.round(result.latencyMs),
        action_json: action ? { ...action } : null,
      };
      deps.store.insert(d);
      if (auto && action) d = await runAction(d, action, a.value, opts);
      if (d.status === 'applied') {
        deps.store.appendEvent({
          id: newEventId(ts.getTime()),
          ts: ts.toISOString(),
          type: 'decision_made',
          subject_type: 'decision',
          subject_id: d.id,
          payload_json: { kind: d.kind, value: a.value, p: a.p, outcome: d.policy_outcome, backend },
          actor: opts.actor ?? 'agent',
          decision_id: d.id,
        });
      }
      decisionIds.push(d.id);
      outcomes.push(d.policy_outcome);
    }

    return { answers: result.answers.map(({ id, value, p }) => ({ id, value, p })), backend, latencyMs, decisionIds, outcomes };
  }

  /**
   * Log an externally judged answer through the policy (contracts `Resolver.record`). No backend
   * call and no second opinion: `auto_second` falls to `human`. Runs the action when auto.
   */
  async function record(input: RecordRequest, opts: AskOptions = {}): Promise<RecordResult> {
    const req = RecordRequest.parse(input);
    const impact: Impact = effectiveImpact(req.decision, req.impact);
    const thresholds = effectiveThresholds(deps.config, req.decision, opts.thresholds);
    const outcome = req.backend === 'human' ? 'human' : finalOutcome(decidePolicy(req.answer, impact, thresholds), false);
    const ts = now();
    const subject = subjectOf(req as unknown as AskRequest);
    const auto = outcome !== 'human';
    let d: Decision = {
      id: newId(),
      ts: ts.toISOString(),
      kind: req.decision,
      subject_type: subject.type,
      subject_id: subject.id,
      question_json: req.question,
      backend: req.backend,
      answer_json: { id: req.answer.id, value: req.answer.value, p: req.answer.p },
      p: req.answer.p,
      impact,
      policy_outcome: outcome,
      status: auto ? 'applied' : 'pending',
      human_choice: null,
      overridden: false,
      undo_until: outcome === 'auto_undo' ? undoUntil(ts, thresholds) : null,
      resolved_at: auto ? ts.toISOString() : null,
      latency_ms: 0,
      action_json: req.action ? { ...req.action } : null,
    };
    deps.store.insert(d);
    if (auto && req.action) d = await runAction(d, req.action as DecisionAction, req.answer.value, opts);
    if (d.status === 'applied') {
      deps.store.appendEvent({
        id: newEventId(ts.getTime()),
        ts: ts.toISOString(),
        type: 'decision_made',
        subject_type: 'decision',
        subject_id: d.id,
        payload_json: { kind: d.kind, value: req.answer.value, p: req.answer.p, outcome: d.policy_outcome, backend: req.backend },
        actor: opts.actor ?? 'agent',
        decision_id: d.id,
      });
    }
    return { decisionId: d.id, outcome: d.policy_outcome };
  }

  return {
    ask,
    record,
    route,
    decide: (answer: Answer, impact: Impact, thresholds: Thresholds) => decidePolicy(answer, impact, thresholds),
  };
}
