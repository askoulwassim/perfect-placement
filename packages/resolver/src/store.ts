import type { Decision, DecisionStatus, EventRow, PolicyOutcome } from '@perfect-placement/contracts';

/*
 * The decisions log interface. Lane A's repository implements it in the engine
 * (packages/engine/ops/decision-store.ts); the resolver never touches the db itself.
 */

export interface DecisionFilter {
  statuses?: DecisionStatus[];
  outcomes?: PolicyOutcome[];
  excludeOutcomes?: PolicyOutcome[];
  since?: string;
}

export interface DecisionStore {
  insert(d: Decision): void;
  get(id: string): Decision | undefined;
  update(id: string, patch: Partial<Omit<Decision, 'id'>>): Decision;
  list(filter?: DecisionFilter): Decision[];
  appendEvent(e: EventRow): void;
}
