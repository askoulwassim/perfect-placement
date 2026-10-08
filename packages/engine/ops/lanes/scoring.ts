import { type EventType, type Role, vaultPath } from '@perfect-placement/contracts';
import { rebalanceCompany, rolesScoreHandler, ScoringError } from '../../scoring/handler.js';
import type { PoolEntry, ScoringStore } from '../../scoring/store.js';
import { OpError } from '../errors.js';
import { appendRoleLog } from '../handlers/shared.js';
import { defineHandler, type HandlerContext } from '../runtime.js';

/*
 * Lane F wiring: `ScoringStore` over lane A repositories and runOp's event writer, the `roles.score`
 * handler, and `rebalance` (the per-company cap) for every op that moves, archives or closes a role.
 */

/**
 * Emit a cap event from an op whose frozen `emits` may not list it: the event itself when allowed,
 * else `role_moved` carrying the cap event name, else nothing (the status row is still right).
 */
function capEmit(h: HandlerContext, type: EventType, subjectId: string, payload: Record<string, unknown>, decisionId: string | null) {
  if (h.canEmit(type)) return h.emit(type, 'role', subjectId, payload, decisionId);
  if (h.canEmit('role_moved')) return h.emit('role_moved', 'role', subjectId, { ...payload, cap_event: type }, decisionId);
  return '';
}

export function scoringStore(h: HandlerContext): ScoringStore {
  const R = h.repos;
  return {
    // Already inside the op's transaction.
    transaction: (fn) => fn(),
    getRole: (id) => R.role.get(id),
    getCompany: (id) => R.company.get(id),
    getProfile(versionId) {
      const v = versionId ? R.profile_version.get(versionId) : R.profile_version.select('1 ORDER BY created_at DESC, id DESC LIMIT 1')[0];
      if (!v) return undefined;
      return { id: v.id, components: R.profile_component.list({ version_id: v.id }) };
    },
    companyPool(companyId) {
      // wave1-decisions #13: only `active` (and `held`) take part in the cap; on-deck never counts.
      return R.role.select(`company_id = ? AND status IN ('active','held')`, [companyId]).map(
        (r): PoolEntry => ({
          role_id: r.id,
          status: r.status as PoolEntry['status'],
          found_at: r.found_at,
          total: R.score.select('role_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [r.id])[0]?.total ?? 0,
        }),
      );
    },
    insertScore: (score) => {
      R.score.insert(score);
    },
    setStatus(roleId, status, reasons, nowIso) {
      const before = R.role.get(roleId) as Role;
      R.role.update(roleId, { status, archive_reason: reasons.archive_reason, held_reason: reasons.held_reason, updated_at: nowIso });
      appendRoleLog(
        h,
        before,
        `${before.status} -> ${status} (${h.name}${reasons.archive_reason ? `: ${reasons.archive_reason}` : reasons.held_reason ? `: ${reasons.held_reason}` : ''})`,
      );
    },
    insertEvent: (e) => {
      capEmit(h, e.type, e.subject_id, e.payload_json, e.decision_id);
    },
  };
}

/** Re-apply the per-company cap (lane F) after a move, archive or close. Returns the roles it moved. */
export function rebalance(h: HandlerContext, companyId: string): string[] {
  return rebalanceCompany(companyId, h.ctx, { store: scoringStore(h), config: h.config }).cap.map((c) => c.role_id);
}

export const rolesScore = defineHandler('roles.score', {
  run(input, h) {
    try {
      const { output } = rolesScoreHandler(input, h.ctx, {
        store: scoringStore(h),
        config: h.config,
        ...(input.profile_version_id ? { profileVersionId: input.profile_version_id } : {}),
      });
      const role = h.repos.role.get(input.role_id);
      if (input.notes && role) {
        const path = role.md_path ?? vaultPath.role(role.id);
        if (h.vault.exists(path)) {
          const lines = Object.entries(input.notes).map(([c, n]) => `- ${c.toUpperCase()}: ${n}`);
          h.vault.append(path, `\n## Score notes (${h.nowIso().slice(0, 10)}, total ${output.score.total})\n\n${lines.join('\n')}\n`);
        }
      }
      return output;
    } catch (e) {
      if (e instanceof ScoringError) throw new OpError(e.code, e.message, e.issues);
      throw e;
    }
  },
});
