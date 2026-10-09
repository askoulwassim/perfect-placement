import { CRITERIA, type Criterion, type EventType, type OpOutput, type Role, type Score, vaultPath } from '@perfect-placement/contracts';
import type { BrandInput, RoleForJudging } from '../../scoring/blind.js';
import { rebalanceCompany, rolesScoreHandler, ScoringError } from '../../scoring/handler.js';
import { AGENT_DEFAULT_P, type JudgeResult, judgeThroughResolver, profileSummaryOf, recordAgentCriteria } from '../../scoring/judge.js';
import { affinityFor, computeScore, WORK_MODE_HITS } from '../../scoring/math.js';
import { rubricFor } from '../../scoring/rubric.js';
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

/** Keys the scorer adds to facts_json; a rescore starts again from the judged facts. */
const COMPUTED_FACTS = ['base_total', 'affinity_raw', 'verify', 'status_kept', 'dealbreaker_hits'];

/**
 * `roles.score` rescore input from a score row: its criteria and judged facts. Computed keys are
 * dropped; only the judged hard nos carry over (computed hits are recomputed against the profile).
 */
export function rescoreInputOf(s: Score): { criteria: Record<Criterion, number>; facts: Record<string, unknown> } {
  const facts = Object.fromEntries(Object.entries(s.facts_json).filter(([k]) => !COMPUTED_FACTS.includes(k)));
  const judged = ((s.facts_json.dealbreaker_hits as unknown[] | undefined) ?? [])
    .filter((x): x is string => typeof x === 'string' && x.startsWith('judged:'))
    .map((x) => x.slice('judged:'.length));
  if (judged.length) facts.dealbreaker_hits = judged;
  const criteria = Object.fromEntries(CRITERIA.map((c) => [c, s[c]])) as Record<Criterion, number>;
  return { criteria, facts };
}

const RESTORE_Q = 'restore';
const WORK_MODE_HIT_SET: ReadonlySet<string> = new Set(WORK_MODE_HITS);

/**
 * `roles.reevaluate_filters` (#83): `dealbreaker` archives whose latest score hit only work-mode rules,
 * re-checked against the current profile. Each one that now passes and would be green gets a Needs-you
 * decision (`roles.move`, medium, always the human) whose action rescores it (`roles.score`, rescore).
 * Never restores on its own; a dry run writes nothing.
 */
export const rolesReevaluateFilters = defineHandler('roles.reevaluate_filters', {
  async run(input, h) {
    const R = h.repos;
    const dry = input.dry_run === true || h.ctx.dryRun === true;
    const store = scoringStore(h);
    const profile = store.getProfile();
    const components = profile?.components ?? [];
    const rubric = rubricFor({ config: h.config, profileVersionId: profile?.id ?? null, components });
    const roles = input.role_ids?.length
      ? input.role_ids.map((id) => R.role.get(id)).filter((r): r is Role => !!r)
      : R.role.select(`status = 'archived' AND archive_reason = 'dealbreaker' ORDER BY id`);
    const items: OpOutput<'roles.reevaluate_filters'>['items'] = [];
    let queued = 0;
    for (const role of roles) {
      if (role.status !== 'archived' || role.archive_reason !== 'dealbreaker') continue;
      const s = R.score.select('role_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [role.id])[0];
      if (!s) continue;
      const oldHits = ((s.facts_json.dealbreaker_hits as unknown[] | undefined) ?? []).filter((x): x is string => typeof x === 'string');
      if (oldHits.length === 0 || !oldHits.every((x) => WORK_MODE_HIT_SET.has(x))) continue;
      const { criteria, facts } = rescoreInputOf(s);
      const company = R.company.get(role.company_id);
      const affinity = company ? affinityFor(company.slug, company.affinity, components) : 0;
      const c = computeScore(criteria, facts, rubric, components, affinity, { location: role.location, workplace: role.workplace });
      const passes = c.dealbreakers.hits.length === 0;
      const pending = R.decision
        .select(`kind = 'roles.move' AND status = 'pending' AND subject_type = 'role' AND subject_id = ?`, [role.id])
        .some((d) => (d.question_json as { id?: unknown }).id === RESTORE_Q);
      const skipped: (typeof items)[number]['skipped'] = !passes
        ? 'fails'
        : c.band !== 'green'
          ? 'below_threshold'
          : pending
            ? 'pending'
            : dry
              ? 'dry_run'
              : null;
      let decision_id: string | null = null;
      if (skipped === null) {
        const company_name = company?.name ?? role.company_id;
        const r = await h.resolver.record(
          {
            decision: 'roles.move',
            impact: 'medium',
            subject: { type: 'role', id: role.id },
            question: {
              id: RESTORE_Q,
              type: 'noulli',
              instructions: `Restore ${role.title} at ${company_name}? It was archived by the old work-mode rule and passes your profile now.`,
              title: role.title,
              company: company_name,
              location: role.location,
              workplace: facts.workplace ?? role.workplace,
              old_hits: oldHits,
              verify: c.dealbreakers.verify,
              total: c.total,
              band: c.band,
            },
            answer: { id: RESTORE_Q, value: true, p: 0.5 },
            backend: 'rule',
            action: { op: 'roles.score', input: { role_id: role.id, criteria, facts, rescore: true }, when: true },
          },
          { actor: h.ctx.actor, forceHuman: true },
        );
        decision_id = r.decisionId;
        queued++;
      }
      items.push({
        role_id: role.id,
        old_hits: oldHits,
        hits: c.dealbreakers.hits,
        verify: c.dealbreakers.verify,
        passes,
        total: c.total,
        band: c.band,
        decision_id,
        skipped,
      });
    }
    return { items, queued };
  },
});
