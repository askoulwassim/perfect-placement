import type { DecisionAction, DecisionKind, HardHumanSubject } from '@perfect-placement/contracts';
import type Database from 'better-sqlite3';
import { get } from './rows.js';

/*
 * Hard-exclusion details the resolver cannot see on its own (wave1-decisions #24): a
 * `profile.apply_diff` decision is always human when the diff touches Dealbreakers, or Terms with a
 * comp floor change. The diff is looked up through lane A's repository.
 */
export function hardHumanHint(
  db: Database.Database,
  req: { kind: DecisionKind; subject?: { type: string; id: string }; action?: DecisionAction },
): HardHumanSubject | undefined {
  if (req.kind !== 'profile.apply_diff' && req.action?.op !== 'profile.apply_diff') return undefined;
  const fromAction = (req.action?.input as { diff_id?: unknown } | undefined)?.diff_id;
  const diffId = typeof fromAction === 'string' ? fromAction : req.subject?.type === 'profile_diff' ? req.subject.id : undefined;
  if (!diffId) return undefined;
  const diff = get(db, 'profile_diff', diffId);
  if (!diff) return undefined;
  return { component: diff.component_key, changedKeys: changedKeys(diff.diff_json) };
}

/** Top-level keys whose value differs between `before` and `after`. */
export function changedKeys(diffJson: Record<string, unknown>): string[] {
  const before = (diffJson.before ?? {}) as Record<string, unknown>;
  const after = (diffJson.after ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
}
