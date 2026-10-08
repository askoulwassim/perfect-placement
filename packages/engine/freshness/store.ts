import type { Actor, AtsType, EventType, RoleStatus, RunStatus } from '@perfect-placement/contracts';

/** A role the freshness run may look at, joined with what we know about its company's ATS. */
export interface ScopeRole {
  id: string;
  title: string;
  url: string | null;
  status: RoleStatus;
  found_at: string | null;
  posted_at: string | null;
  freshness: string;
  last_checked_at: string | null;
  flags_json: Record<string, unknown>;
  company_id: string;
  company_name: string;
  ats_type: AtsType | null;
  ats_board: string | null;
}

export interface FreshnessEvent {
  type: EventType;
  subjectId: string;
  payload: Record<string, unknown>;
  actor: Actor;
  decisionId: string | null;
  ts: string;
}

type MaybePromise<T> = T | Promise<T>;

/**
 * Everything the freshness run reads or writes. Wave 1 ships `sqliteStore` (a direct-SQL shim);
 * Wave 2 swaps in a store backed by lane A repositories + lane B ops (`roles.archive`, event writer,
 * run log), so the run itself never changes.
 */
export interface FreshnessStore {
  /** Roles in FRESHNESS_SCOPE only (optionally limited to ids). Applied-or-later roles never appear. */
  listInScope(roleIds?: string[]): MaybePromise<ScopeRole[]>;
  /** Open or unsure: set freshness, last_checked_at, flags. Must refuse roles outside scope. */
  recordCheck(u: { roleId: string; freshness: 'open' | 'unsure'; at: string; flags: Record<string, unknown> }): MaybePromise<boolean>;
  /** Closed: archive with reason `closed`. Must refuse roles outside scope. Returns false if refused. */
  archiveClosed(u: { roleId: string; at: string; flags: Record<string, unknown>; decisionId: string | null }): MaybePromise<boolean>;
  emit(e: FreshnessEvent): MaybePromise<string>;
  /** Attach the op a human accept should run to a pending decision (see CONTRACT_CHANGES "Lane G requests"). */
  attachDecisionAction(decisionId: string, action: { op: string; input: Record<string, unknown> }): MaybePromise<void>;
  startRun(op: string, at: string): MaybePromise<string>;
  finishRun(id: string, u: { at: string; status: RunStatus; summary: Record<string, unknown>; logPath: string | null }): MaybePromise<void>;
}
