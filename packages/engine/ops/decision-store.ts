import type { DecisionFilter, DecisionStore } from '@perfect-placement/resolver';
import type Database from 'better-sqlite3';
import { repos } from '../db/repo.js';

/*
 * Lane I's `DecisionStore`, implemented over lane A's repositories (docs/history/contract-changes.md "Decision
 * repository ownership"). The resolver writes decision rows and decision events only through this.
 */
export function createDecisionStore(db: Database.Database): DecisionStore {
  const R = repos(db);
  return {
    insert(d) {
      R.decision.insert(d);
    },
    get: (id) => R.decision.get(id),
    update: (id, patch) => R.decision.update(id, patch),
    list(filter: DecisionFilter = {}) {
      const where: string[] = [];
      const params: unknown[] = [];
      const inList = (col: string, values: readonly string[] | undefined, not = false) => {
        if (!values?.length) return;
        where.push(`${col} ${not ? 'NOT IN' : 'IN'} (${values.map(() => '?').join(',')})`);
        params.push(...values);
      };
      inList('status', filter.statuses);
      inList('policy_outcome', filter.outcomes);
      inList('policy_outcome', filter.excludeOutcomes, true);
      if (filter.since) {
        where.push('ts >= ?');
        params.push(filter.since);
      }
      return R.decision.select(`${where.length ? where.join(' AND ') : '1'} ORDER BY ts DESC, id DESC`, params);
    },
    appendEvent(e) {
      R.event.insert(e);
    },
  };
}
