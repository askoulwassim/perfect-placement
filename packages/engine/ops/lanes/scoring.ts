import { CRITERIA, type Criterion, type EventType, type Role, vaultPath } from '@perfect-placement/contracts';
import type { BrandInput, RoleForJudging } from '../../scoring/blind.js';
import { rebalanceCompany, rolesScoreHandler, ScoringError } from '../../scoring/handler.js';
import { AGENT_DEFAULT_P, type JudgeResult, judgeThroughResolver, profileSummaryOf, recordAgentCriteria } from '../../scoring/judge.js';
import type { PoolEntry, ScoringStore } from '../../scoring/store.js';
import { OpError } from '../errors.js';
import { appendRoleLog } from '../handlers/shared.js';
import { defineHandler, type HandlerContext, requiresHuman } from '../runtime.js';
import { stripFrontmatter } from '../vault.js';

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

/** Brand, role text and profile summary the judge needs (blind masking + open state). */
function judgingInputs(h: HandlerContext, roleId: string, extraTerms: readonly string[] = []) {
  const role = h.repos.role.get(roleId);
  if (!role) throw new OpError('not_found', `role ${roleId} not found`);
  const company = h.repos.company.get(role.company_id);
  if (!company) throw new OpError('not_found', `company ${role.company_id} not found`);
  const path = role.md_path ?? vaultPath.role(role.id);
  const md = h.vault.exists(path) ? h.vault.read(path) : null;
  const comp =
    role.comp_min !== null || role.comp_max !== null
      ? `${role.comp_min ?? '?'}-${role.comp_max ?? '?'} ${role.comp_currency ?? ''}`.trim()
      : '';
  const judged: RoleForJudging = {
    role_id: role.id,
    title: role.title,
    jd: md ? stripFrontmatter(md) : '',
    location: role.location,
    workplace: role.workplace,
    comp,
  };
  const brand: BrandInput = { name: company.name, slug: company.slug, domain: company.domain, terms: extraTerms };
  const v = h.repos.profile_version.select('1 ORDER BY created_at DESC, id DESC LIMIT 1')[0];
  const profile = v ? profileSummaryOf(h.repos.profile_component.list({ version_id: v.id })) : '';
  return { role: judged, brand, profile };
}

/**
 * Human fallback state for a role (#40): criterion decisions a human holds since the last score.
 * Pending ones block a new ask (no duplicates in Needs you); nine resolved ones are the criteria.
 */
function humanCriteria(
  h: HandlerContext,
  roleId: string,
): { pending: string[]; resolved: Record<Criterion, { decision_id: string; value: number }> | null } {
  const last = h.repos.score.select('role_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [roleId])[0];
  const rows = h.repos.decision.select(
    `kind = 'roles.criterion' AND subject_type = 'role' AND subject_id = ? AND backend = 'human' AND status IN ('pending','applied') AND ts > ? ORDER BY ts, rowid`,
    [roleId, last?.created_at ?? ''],
  );
  const pending = rows.filter((d) => d.status === 'pending').map((d) => d.id);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const d of rows) latest.set(String((d.question_json as { id?: unknown }).id), d);
  const resolved = {} as Record<Criterion, { decision_id: string; value: number }>;
  for (const c of CRITERIA) {
    const d = latest.get(c);
    const value = Math.round(Number(d?.human_choice));
    if (d?.status !== 'applied' || !(value >= 1 && value <= 5)) return { pending, resolved: null };
    resolved[c] = { decision_id: d.id, value };
  }
  return { pending, resolved };
}

const CARRIED = ['criteria_source', 'second_opinion', 'disagreements'] as const;

export const rolesScore = defineHandler('roles.score', {
  async run(input, h) {
    try {
      let criteria = input.criteria;
      let judge: Record<string, unknown> = {};
      if (!input.rescore) {
        const { role, brand, profile } = judgingInputs(h, input.role_id, input.brand_terms);
        let result: JudgeResult | null = null;
        if (criteria) {
          const resolver = h.resolver;
          result = await recordAgentCriteria(
            {
              ask: (req) => resolver.ask(req, { actor: h.ctx.actor }),
              record: (req, o) => resolver.record(req, { actor: h.ctx.actor, ...o }),
              consult: (b, req) => resolver.consult(b, req),
            },
            role,
            brand,
            profile,
            criteria as Record<Criterion, number>,
            input.criteria_p ?? {},
            h.ctx.confidence?.p ?? AGENT_DEFAULT_P,
          );
        } else {
          const human = humanCriteria(h, input.role_id);
          if (human.pending.length) return requiresHuman(human.pending[0] as string);
          if (human.resolved) {
            const r = human.resolved;
            criteria = Object.fromEntries(CRITERIA.map((c) => [c, r[c].value])) as Record<Criterion, number>;
            judge = {
              criteria_source: Object.fromEntries(
                CRITERIA.map((c) => [c, { backend: 'human', p: 1, decision_id: r[c].decision_id, latency_ms: 0 }]),
              ),
            };
          } else {
            result = await judgeThroughResolver({ ask: (req) => h.resolver.ask(req, { actor: h.ctx.actor }) }, role, brand, profile);
            if (result.kind === 'human') {
              // An attached agent is the next rung: it judges and calls again with criteria (nothing is queued).
              if (h.ctx.actor === 'agent')
                throw new OpError(
                  'backend_unavailable',
                  'Kev did not answer: judge C1..C9 yourself (blind for C1 C2 C3 C4 C9) and call roles.score with criteria',
                );
              return requiresHuman(result.decision_ids[0] as string);
            }
          }
        }
        if (result?.kind === 'judged') {
          criteria = result.criteria;
          judge = { ...result.facts };
        }
      }
      if (!criteria) throw new OpError('invalid_input', 'roles.score: rescore needs criteria');
      // A rescore keeps the judged sources it carries in facts; a new judgment replaces them.
      const facts = {
        ...Object.fromEntries(Object.entries(input.facts).filter(([k]) => input.rescore || !(CARRIED as readonly string[]).includes(k))),
        ...judge,
      };
      const { output } = rolesScoreHandler({ ...input, criteria, facts }, h.ctx, {
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
