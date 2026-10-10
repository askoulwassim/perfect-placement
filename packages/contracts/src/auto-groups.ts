import type { Decision } from './entities.js';
import type { Backend, DecisionKind } from './enums.js';
import type { AutoGroup } from './ops/registry.js';

/*
 * #103: the auto stream on Now, grouped. One row per subject per run (e.g. a role's nine criterion
 * decisions from one score run), or per run for batch kinds (contact classifications, freshness).
 * Decisions with no run id group by kind (+ subject) and a time window instead.
 */

/** Kinds grouped per run across subjects (a batch of contacts, a freshness sweep). */
export const AUTO_BATCH_KINDS: readonly DecisionKind[] = ['people.classify', 'freshness.closed'];

/** With no run id, members of one group are at most this far apart (chained). */
export const AUTO_GROUP_WINDOW_MS = 10 * 60_000;

export interface AutoGroupHints {
  /** The run a decision was made in, if known. */
  runOf?: (d: Decision) => string | null;
  /** The total to show for a group (roles.criterion: the role's score). */
  totalOf?: (g: Omit<AutoGroup, 'total'>) => number | null;
}

/** Can this decision be undone now (auto + undo, applied, inside its window)? Same rule as the resolver. */
export function isUndoableNow(d: Pick<Decision, 'policy_outcome' | 'status' | 'undo_until'>, now: Date): boolean {
  if (d.policy_outcome !== 'auto_undo' || d.status !== 'applied' || !d.undo_until) return false;
  return now.getTime() <= Date.parse(d.undo_until);
}

function majorityBackend(members: readonly Decision[]): Backend | 'mixed' {
  const n = new Map<Backend, number>();
  for (const d of members) n.set(d.backend, (n.get(d.backend) ?? 0) + 1);
  for (const [b, c] of n) if (c * 2 > members.length) return b;
  return 'mixed';
}

/**
 * Group auto decisions (any order) into AutoGroups, newest group first; members newest first.
 * Kind is always part of the key, so mixed kinds never share a group.
 */
export function groupAutoDecisions(decisions: readonly Decision[], now: Date, hints: AutoGroupHints = {}): AutoGroup[] {
  const asc = [...decisions].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const byRun = new Map<string, Decision[]>();
  const open = new Map<string, Decision[]>();
  const buckets: Decision[][] = [];
  for (const d of asc) {
    const run = hints.runOf?.(d) ?? null;
    const subject = AUTO_BATCH_KINDS.includes(d.kind) ? '*' : `${d.subject_type}:${d.subject_id}`;
    const key = `${d.kind}|${subject}`;
    if (run) {
      const k = `${key}|${run}`;
      let b = byRun.get(k);
      if (!b) {
        b = [];
        byRun.set(k, b);
        buckets.push(b);
      }
      b.push(d);
      continue;
    }
    const b = open.get(key);
    const last = b?.[b.length - 1];
    if (b && last && Date.parse(d.ts) - Date.parse(last.ts) <= AUTO_GROUP_WINDOW_MS) b.push(d);
    else {
      const fresh = [d];
      open.set(key, fresh);
      buckets.push(fresh);
    }
  }
  const groups = buckets.map((members): AutoGroup => {
    const first = members[0] as Decision;
    const latest = members[members.length - 1] as Decision;
    const subjects = new Set(members.map((d) => `${d.subject_type}:${d.subject_id}`));
    const subjectTypes = new Set(members.map((d) => d.subject_type));
    const desc = [...members].reverse();
    const base: Omit<AutoGroup, 'total'> = {
      id: `ag_${first.id}`,
      kind: first.kind,
      subject_type: subjectTypes.size === 1 ? first.subject_type : 'system',
      subject_id: subjects.size === 1 ? first.subject_id : null,
      run_id: hints.runOf?.(first) ?? null,
      decision_ids: desc.map((d) => d.id),
      count: members.length,
      backend: majorityBackend(members),
      first_ts: first.ts,
      ts: latest.ts,
      undoable_ids: desc.filter((d) => isUndoableNow(d, now)).map((d) => d.id),
      undone_count: members.filter((d) => d.status === 'undone').length,
    };
    return { ...base, total: hints.totalOf?.(base) ?? null };
  });
  return groups.sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id));
}
