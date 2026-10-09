import type { PolicyConfig, Run, RunStatus, Skill } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { get, select } from './rows.js';

/*
 * The run queue and the automatic pipeline (#30). Mechanics only; the handlers in handlers/runs.ts
 * do the writes.
 *
 * - Queue runs: started by a human or a schedule (`summary_json.actor` not `agent`). They are created
 *   `queued`; `runs.dispatch` launches them oldest first, at most `config.runs.max_concurrent` running.
 *   An agent's own run is never queued, launched, deduped against or counted.
 * - Scope: skill + role + contact + outreach; research is scoped to the company (one dossier per company).
 *   No two active queue runs share a scope, except a pipeline score run for the whole inbox, which may
 *   wait behind a running one (that run listed the inbox before the new roles arrived).
 */

export interface RunSummaryFields {
  skill?: string;
  role_id?: string;
  contact_id?: string;
  outreach_id?: string;
  company_id?: string;
  actor?: string;
  runner?: string;
  triggered_by?: string;
  triggered_by_skill?: string;
  triggered?: string[];
  queued_at?: string;
  launched_at?: string;
}

export const summaryOf = (r: Run): RunSummaryFields => (r.summary_json ?? {}) as RunSummaryFields;

export interface RunScope {
  skill: string;
  role_id?: string | undefined;
  contact_id?: string | undefined;
  outreach_id?: string | undefined;
  company_id?: string | undefined;
}

export function scopeOf(r: Run): RunScope {
  const s = summaryOf(r);
  return { skill: r.op, role_id: s.role_id, contact_id: s.contact_id, outreach_id: s.outreach_id, company_id: s.company_id };
}

/** Same skill and scope. Research compares companies when both runs know theirs. */
export function sameScope(a: RunScope, b: RunScope): boolean {
  if (a.skill !== b.skill) return false;
  if (a.skill === 'research' && a.company_id && b.company_id) return a.company_id === b.company_id;
  return a.role_id === b.role_id && a.contact_id === b.contact_id && a.outreach_id === b.outreach_id;
}

/** A run the queue owns (a human or schedule started it), as opposed to an agent session's own run. */
export const isQueueRun = (r: Run): boolean => summaryOf(r).actor !== undefined && summaryOf(r).actor !== 'agent';

/** Queue runs in these states, oldest first. */
export function queueRuns(db: Database.Database, statuses: readonly RunStatus[]): Run[] {
  const marks = statuses.map(() => '?').join(',');
  return select(db, 'run', `status IN (${marks}) ORDER BY started_at ASC, id ASC`, statuses).filter(isQueueRun);
}

/** The active queue run a new run with this scope would duplicate, if any. */
export function activeDuplicate(db: Database.Database, scope: RunScope, opts: { queuedOnly?: boolean } = {}): Run | undefined {
  return queueRuns(db, opts.queuedOnly ? ['queued'] : ['queued', 'running']).find((r) => sameScope(scopeOf(r), scope));
}

/** What `runs.finish` should enqueue next (pipeline rules), for a run that just ended with `status`. */
export interface PipelineStart {
  skill: Skill;
  role_id?: string;
}

/**
 * The pipeline rules (config `pipeline`):
 * - scout ended `ok` and the inbox has roles: one score run for the whole inbox (it covers the new roles).
 * - score ended `ok` or `partial`: for each role it scored that is still in the pipeline (not inbox,
 *   not archived) and whose company has no dossier, one research run per company (scoped by a role there).
 */
export function pipelineStarts(db: Database.Database, config: PolicyConfig, run: Run, status: RunStatus): PipelineStart[] {
  if (run.op === 'scout' && status === 'ok' && config.pipeline.score_after_scout) {
    const inbox = select(db, 'role', 'status = ? LIMIT 1', ['inbox']);
    return inbox.length ? [{ skill: 'score' }] : [];
  }
  if (run.op === 'score' && (status === 'ok' || status === 'partial') && config.pipeline.research_after_score) {
    // Roles this run scored: role_scored events since it started (an event that names another run is not ours).
    const events = select(db, 'event', 'type = ? AND ts >= ? ORDER BY ts ASC, id ASC', ['role_scored', run.started_at]);
    const out: PipelineStart[] = [];
    const companies = new Set<string>();
    for (const e of events) {
      const by = (e.payload_json as { run_id?: unknown } | null)?.run_id;
      if (typeof by === 'string' && by !== run.id) continue;
      const role = get(db, 'role', e.subject_id);
      if (!role || role.status === 'inbox' || role.status === 'archived' || companies.has(role.company_id)) continue;
      companies.add(role.company_id);
      const company = get(db, 'company', role.company_id);
      if (!company || company.md_path) continue;
      out.push({ skill: 'research', role_id: role.id });
    }
    return out;
  }
  return [];
}
