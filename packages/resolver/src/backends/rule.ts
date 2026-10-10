import type { Answer, AskRequest, BackendResult, DecisionBackend, Question } from '@perfect-placement/contracts';
import { BackendUnavailableError } from '../errors.js';

/*
 * Rule backend: numbers and dates (System One models are weak on both). Deterministic, p = 1.
 * A rule is keyed by question id. The resolver routes a request here when every question has a rule.
 */

export type Rule = (q: Question, state: Record<string, string>, now: Date) => Answer['value'] | undefined;
export type RuleSet = Record<string, Rule>;

const num = (s: string | undefined): number | undefined => {
  if (s === undefined || s.trim() === '') return undefined;
  const n = Number(s.replace(/[$,_\s]/g, '').replace(/k$/i, '000'));
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Built-in rules.
 * - `meets_comp_floor` (noulli): state.comp_max (or comp_min) >= state.comp_floor.
 * - `posting_stale` (noulli): now - state.posted_at > state.stale_after_days.
 * - `posting_age_days` (score): whole days since state.posted_at, clamped to [min, max].
 */
export const BUILTIN_RULES: RuleSet = {
  meets_comp_floor: (_q, s) => {
    const floor = num(s.comp_floor);
    const top = num(s.comp_max) ?? num(s.comp_min);
    if (floor === undefined || top === undefined) return undefined;
    return top >= floor;
  },
  posting_stale: (_q, s, now) => {
    const posted = s.posted_at ? Date.parse(s.posted_at) : Number.NaN;
    const days = num(s.stale_after_days);
    if (Number.isNaN(posted) || days === undefined) return undefined;
    return (now.getTime() - posted) / 86_400_000 > days;
  },
  posting_age_days: (q, s, now) => {
    const posted = s.posted_at ? Date.parse(s.posted_at) : Number.NaN;
    if (Number.isNaN(posted) || q.type !== 'score') return undefined;
    const d = Math.floor((now.getTime() - posted) / 86_400_000);
    return Math.min(q.max, Math.max(q.min, d));
  },
};

const asRecord = (state: AskRequest['state']): Record<string, string> => (typeof state === 'string' ? {} : state);

export interface RuleBackend extends DecisionBackend {
  /** True when every question has a rule that yields a value for this state. */
  canAnswer(req: AskRequest): boolean;
}

export function createRuleBackend(opts: { rules?: RuleSet; now?: () => Date } = {}): RuleBackend {
  const rules = { ...BUILTIN_RULES, ...(opts.rules ?? {}) };
  const now = opts.now ?? (() => new Date());
  const evaluate = (q: Question, req: AskRequest) => rules[q.id]?.(q, asRecord(req.state), now());
  return {
    name: 'rule',
    canAnswer(req) {
      return req.questions.every((q) => evaluate(q, req) !== undefined);
    },
    async ask(req): Promise<BackendResult> {
      const answers = req.questions.map((q) => {
        const value = evaluate(q, req);
        if (value === undefined) throw new BackendUnavailableError('rule', `no rule for '${q.id}'`);
        return { id: q.id, value, p: 1 };
      });
      return { answers, latencyMs: 0 };
    },
    async health() {
      return { ok: true, latencyMs: 0 };
    },
  };
}
