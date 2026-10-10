import { z } from 'zod';
import { DecisionAction } from './entities.js';
import { Backend, DecisionKind, Impact, PolicyOutcome } from './enums.js';
import type { Thresholds } from './policy.js';
import { Probability } from './primitives.js';

/*
 * Resolver interface (contracts.md). Lane I implements; every other lane calls `ask()`.
 * System One models (Kev) only answer typed questions. They never write text.
 * Routing (wave1-decisions #9): rule -> kev -> agent (the calling session) -> human.
 */

export const OTHER_OPTION = 'other';

export const ChoiceQuestion = z.object({
  id: z.string(),
  type: z.literal('choice'),
  instructions: z.string(),
  /** Must include OTHER_OPTION (a System One model always picks an option). */
  options: z
    .array(z.string())
    .min(2)
    .refine((o) => o.includes(OTHER_OPTION), `options must include '${OTHER_OPTION}'`),
});
export const NoulliQuestion = z.object({
  id: z.string(),
  type: z.literal('noulli'),
  instructions: z.string(),
});
export const ScoreQuestion = z.object({
  id: z.string(),
  type: z.literal('score'),
  instructions: z.string(),
  min: z.number(),
  max: z.number(),
});
export const Question = z.discriminatedUnion('type', [ChoiceQuestion, NoulliQuestion, ScoreQuestion]);
export type Question = z.infer<typeof Question>;

export const AskRequest = z.object({
  decision: DecisionKind,
  impact: Impact,
  state: z.union([z.string(), z.record(z.string(), z.string())]),
  questions: z.array(Question).min(1),
  subject: z.object({ type: z.string(), id: z.string() }).optional(),
  /** Force a backend (evals, tests). Omit to use config routing. */
  backend: Backend.optional(),
  /** The op every question's decision runs when applied (written to `decision.action_json`). */
  action: DecisionAction.optional(),
  /** Per question id; wins over `action` for that question. */
  actions: z.record(z.string(), DecisionAction).optional(),
});
export type AskRequest = z.infer<typeof AskRequest>;

export const Answer = z.object({
  id: z.string(),
  value: z.union([z.string(), z.boolean(), z.number()]),
  p: Probability,
});
export type Answer = z.infer<typeof Answer>;

export const AskResult = z.object({
  answers: z.array(Answer),
  backend: Backend,
  latencyMs: z.number().nonnegative(),
  /** One decision row per answer, same order. */
  decisionIds: z.array(z.string()),
  /** Policy outcome per answer, same order. */
  outcomes: z.array(PolicyOutcome),
});
export type AskResult = z.infer<typeof AskResult>;

/**
 * A judgment made outside the resolver (a skill's email classification with its p, an agent
 * stating its confidence for a medium-impact op). The resolver applies policy and logs a
 * decision row without asking a backend again (Wave 2, lane B request).
 */
export const RecordRequest = z.object({
  decision: DecisionKind,
  impact: Impact,
  subject: z.object({ type: z.string(), id: z.string() }),
  /** The Question plus the state it was judged on (stored as question_json). */
  question: z.record(z.string(), z.unknown()),
  answer: Answer,
  backend: Backend,
  action: DecisionAction.optional(),
});
export type RecordRequest = z.infer<typeof RecordRequest>;

export interface RecordResult {
  decisionId: string;
  outcome: PolicyOutcome;
}

/** What a single backend returns. The resolver adds decision rows and policy outcomes. */
export interface BackendResult {
  answers: Answer[];
  latencyMs: number;
}

/** Every decision backend (rule, kev, agent, llm, human) implements this. */
export interface DecisionBackend {
  readonly name: Backend;
  ask(req: AskRequest): Promise<BackendResult>;
  /** Cheap reachability check for Settings + fallback routing. */
  health(): Promise<{ ok: boolean; latencyMs?: number }>;
}

export interface Resolver {
  ask(req: AskRequest): Promise<AskResult>;
  /** Log an externally judged answer through the policy (no backend call). */
  record(req: RecordRequest): Promise<RecordResult>;
  decide(answer: Answer, impact: Impact, thresholds: Thresholds): PolicyOutcome;
}

export type AskFn = Resolver['ask'];
export type RecordFn = Resolver['record'];
export type DecideFn = Resolver['decide'];
