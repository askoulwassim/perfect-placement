import { FRESHNESS_SCOPE, type Role, type RoleStatus } from '@perfect-placement/contracts';
import { checkFreshness } from '../../freshness/run.js';
import type { FreshnessStore, ScopeRole } from '../../freshness/store.js';
import { defaultFetch } from '../../integrations/ats/index.js';
import { checkTransition } from '../../status/index.js';
import { OpError } from '../errors.js';
import { appendRoleLog } from '../handlers/shared.js';
import { newId } from '../ids.js';
import { select, update } from '../rows.js';
import { defineHandler, type HandlerContext } from '../runtime.js';
import { rebalance } from './scoring.js';

/*
 * Lane G wiring: `FreshnessStore` over lane A repositories and runOp's event writer. Closing a role
 * goes through the status machine (automated closes of draft-ready follow the grid, #18) and re-applies
 * the company cap. The resolver is this op's (rule -> Kev -> agent -> human).
 */

const inScope = (s: RoleStatus) => (FRESHNESS_SCOPE as readonly RoleStatus[]).includes(s);

function freshnessStore(h: HandlerContext): FreshnessStore {
  const R = h.repos;
  const scopeRole = (r: Role): ScopeRole => {
    const c = R.company.get(r.company_id);
    return {
      id: r.id,
      title: r.title,
      url: r.url,
      status: r.status,
      found_at: r.found_at,
      posted_at: r.posted_at,
      freshness: r.freshness,
      last_checked_at: r.last_checked_at,
      flags_json: r.flags_json,
      company_id: r.company_id,
      company_name: c?.name ?? r.company_id,
      ats_type: c?.ats_type ?? null,
      ats_board: c?.ats_board ?? null,
    };
  };
  return {
    listInScope(roleIds) {
      if (roleIds && roleIds.length === 0) return [];
      const scope = FRESHNESS_SCOPE.map(() => '?').join(',');
      const ids = roleIds ? ` AND id IN (${roleIds.map(() => '?').join(',')})` : '';
      return R.role.select(`status IN (${scope})${ids} ORDER BY id`, [...FRESHNESS_SCOPE, ...(roleIds ?? [])]).map(scopeRole);
    },
    recordCheck({ roleId, freshness, at, flags }) {
      const r = R.role.get(roleId);
      if (!r || !inScope(r.status)) return false;
      R.role.update(roleId, { freshness, last_checked_at: at, flags_json: flags, updated_at: at });
      return true;
    },
    archiveClosed({ roleId, at, flags }) {
      const r = R.role.get(roleId);
      if (!r || !inScope(r.status)) return false;
      const check = checkTransition({ from: r.status, to: 'archived', actor: h.ctx.actor, via: 'archive', archiveReason: 'closed' });
      if (!check.ok) return false;
      R.role.update(roleId, {
        status: 'archived',
        archive_reason: 'closed',
        held_reason: null,
        freshness: 'closed',
        last_checked_at: at,
        flags_json: flags,
        updated_at: at,
      });
      appendRoleLog(h, r, `${r.status} -> archived (roles.check_freshness: closed)`);
      if (r.status === 'active' || r.status === 'held') rebalance(h, r.company_id);
      return true;
    },
    expirePendingCloses(roleId, at) {
      const pending = select(
        h.db,
        'decision',
        `kind = 'freshness.closed' AND status = 'pending' AND subject_type = 'role' AND subject_id = ?`,
        [roleId],
      );
      for (const d of pending) update(h.db, 'decision', d.id, { status: 'expired', resolved_at: at });
      return pending.length;
    },
    emit: (e) => h.emit(e.type, 'role', e.subjectId, e.payload, e.decisionId),
    startRun(op, at) {
      const id = newId('run', new Date(at));
      R.run.insert({ id, op, started_at: at, finished_at: null, status: 'running', summary_json: {}, log_path: null });
      return id;
    },
    finishRun(id, { at, status, summary, logPath }) {
      R.run.update(id, { finished_at: at, status, summary_json: summary, log_path: logPath });
    },
  };
}

export const rolesCheckFreshness = defineHandler('roles.check_freshness', {
  async run(input, h) {
    try {
      const store = freshnessStore(h);
      const run = await checkFreshness(input, h.ctx, {
        store,
        fetch: h.services.fetch ?? defaultFetch(),
        ask: (req) => h.resolver.ask(req, { actor: h.ctx.actor }),
        record: (req, o) => h.resolver.record(req, { actor: h.ctx.actor, ...(o?.thresholds ? { thresholds: o.thresholds } : {}) }),
        config: h.config,
        ...(h.services.freshnessDelayMs !== undefined ? { delayMs: h.services.freshnessDelayMs } : {}),
        ...(h.services.sleep ? { sleep: h.services.sleep } : {}),
        writeRunLog: (rel, md) => {
          // Unique per run: a second check on the same day gets its own log.
          let path = rel;
          for (let n = 2; h.vault.exists(path); n++) path = rel.replace(/\.md$/, `-${n}.md`);
          h.vault.write(path, md);
          return path;
        },
      });
      return run.output;
    } catch (e) {
      if (e instanceof OpError) throw e;
      throw new OpError('internal', e instanceof Error ? e.message : String(e));
    }
  },
});
