import { z } from 'zod';
import { Backend, DecisionKind, Impact, PolicyOutcome } from './enums.js';
import type { Thresholds } from './policy.js';
import { Probability } from './primitives.js';

/*
 * Resolver interface (contracts.md). Lane I implements; every other lane calls `ask()`.
 * System One models (Jev, Kev) only answer typed questions. They never write text.
 */

export const OTHER_OPTION = 'other';

export const ChoiceQuestion = z.object({
  id: z.string(),
  type: z.literal('choice'),
  instructions: z.string(),
  /** Must include OTHER_OPTION (Jev always picks an option). */
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

/** What a single backend returns. The resolver adds decision rows and policy outcomes. */
export interface BackendResult {
  answers: Answer[];
  latencyMs: number;
}

/** Every decision backend (rule, jev, kev, llm, human) implements this. */
export interface DecisionBackend {
  readonly name: Backend;
  ask(req: AskRequest): Promise<BackendResult>;
  /** Cheap reachability check for Settings + fallback routing. */
  health(): Promise<{ ok: boolean; latencyMs?: number }>;
}

export interface Resolver {
  ask(req: AskRequest): Promise<AskResult>;
  decide(answer: Answer, impact: Impact, thresholds: Thresholds): PolicyOutcome;
}

export type AskFn = Resolver['ask'];
export type DecideFn = Resolver['decide'];
