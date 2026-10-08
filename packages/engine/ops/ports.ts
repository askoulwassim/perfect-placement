import type {
  Answer,
  Backend,
  DecisionKind,
  Impact,
  OpContext,
  OpName,
  PolicyConfig,
  PolicyOutcome,
  SubjectType,
} from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';

/** What an approved decision runs: stored in `decision.action_json`. */
export interface DecisionAction {
  op: OpName | string;
  input: unknown;
}

export interface RecordDecisionRequest {
  kind: DecisionKind;
  impact: Impact;
  subject: { type: SubjectType; id: string };
  /** The Question plus the state it was asked on (stored as question_json). */
  question: Record<string, unknown>;
  /** The judged answer, with its probability. */
  answer: Answer;
  backend: Backend;
  action: DecisionAction | null;
  /** Skip policy: always queue for a human (no confidence was supplied). */
  forceHuman?: boolean;
}

export interface RecordDecisionResult {
  decisionId: string;
  outcome: PolicyOutcome;
}

/**
 * How ops route a judgment through the confidence x impact policy and log it.
 * Used when the judgment was made outside the resolver (a skill classified an email,
 * an agent asked for a medium-impact op). Lane I owns the real implementation;
 * `_shim/decisions.ts` stands in until Wave 2.
 */
export interface DecisionPort {
  record(db: Database.Database, req: RecordDecisionRequest, env: { ctx: OpContext; config: PolicyConfig }): RecordDecisionResult;
}
