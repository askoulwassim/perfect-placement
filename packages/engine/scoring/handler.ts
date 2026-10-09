import {
  type ArchiveReason,
  type EventType,
  ID_PREFIX,
  type OpContext,
  type OpErrorCode,
  type OpInput,
  type OpOutput,
  type PolicyConfig,
  type RoleStatus,
  rolesScore,
  type Score,
  type ScoreDecision,
} from '@perfect-placement/contracts';
import { allocateCompanySlots, type CapTransition, capTransitions } from './cap.js';
import { affinityFor, type Criteria, computeScore, type ScoreFacts } from './math.js';
import { rubricFor, rubricSnapshot, type Scale } from './rubric.js';
import { newId as defaultNewId, type PoolEntry, type ScoringStore } from './store.js';

export class ScoringError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
  }
}

export interface ScoringDeps {
  store: ScoringStore;
  config: PolicyConfig;
  /** Score under this profile version; default = latest. */
  profileVersionId?: string;
  scale?: Scale;
  newId?: (prefix: string, now: Date) => string;
}

/** Statuses a rescore may change. Everything else is held where it is (no-downgrade + human picks). */
const MOVABLE: ReadonlySet<RoleStatus> = new Set(['inbox', 'active', 'held']);
/** Archived roles a rescore may revive (the score put them there). closed/rejected/passed/withdrawn/duplicate stay. */
const REVIVABLE: ReadonlySet<ArchiveReason> = new Set(['below_threshold', 'dealbreaker']);

export function isMovable(status: RoleStatus, archiveReason: ArchiveReason | null): boolean {
  return MOVABLE.has(status) || (status === 'archived' && archiveReason !== null && REVIVABLE.has(archiveReason));
}

type Emit = (type: EventType, subjectId: string, payload: Record<string, unknown>) => string;

function emitter(deps: ScoringDeps, ctx: OpContext, ids: string[]): Emit {
  const mk = deps.newId ?? defaultNewId;
  return (type, subjectId, payload) => {
    const now = ctx.now();
    const id = mk(ID_PREFIX.event, now);
    deps.store.insertEvent({
      id,
      ts: now.toISOString(),
      type,
      subject_type: 'role',
      subject_id: subjectId,
      payload_json: { ...payload, ...(ctx.runId ? { run_id: ctx.runId } : {}) },
      actor: ctx.actor,
      decision_id: ctx.decisionId ?? null,
    });
    ids.push(id);
    return id;
  };
}

function applyCapTransitions(deps: ScoringDeps, ctx: OpContext, emit: Emit, ts: CapTransition[], companyId: string): void {
  const nowIso = ctx.now().toISOString();
  for (const t of ts) {
    deps.store.setStatus(t.role_id, t.to, { archive_reason: null, held_reason: t.to === 'held' ? 'company_cap' : null }, nowIso);
    emit(t.to === 'held' ? 'role_held' : 'role_promoted', t.role_id, {
      from: t.from,
      to: t.to,
      reason: 'company_cap',
      company_id: companyId,
    });
  }
}

const poolMap = (pool: readonly PoolEntry[]) => new Map(pool.map((p) => [p.role_id, p.status] as const));

export interface RolesScoreResult {
  output: OpOutput<'roles.score'>;
  eventIds: string[];
  /** Other roles moved by the per-company cap. */
  cap: CapTransition[];
}

/**
 * `roles.score` handler. Judgment (criteria, facts) comes in; mechanics happen here:
 * weights from the profile version, total, capped affinity, band, dealbreakers (no company bypass),
 * per-company cap (held + automatic promotion), append-only score row, status, events.
 */
export function rolesScoreHandler(rawInput: OpInput<'roles.score'> | unknown, ctx: OpContext, deps: ScoringDeps): RolesScoreResult {
  const parsed = rolesScore.input.safeParse(rawInput);
  if (!parsed.success) throw new ScoringError('invalid_input', 'roles.score: invalid input', parsed.error.issues);
  const input = parsed.data;
  const { store, config } = deps;
  // The op judges missing criteria through the resolver first (ops/lanes/scoring.ts); mechanics need all nine.
  if (!input.criteria) throw new ScoringError('invalid_input', 'roles.score: criteria are judged before the handler runs');

  const role = store.getRole(input.role_id);
  if (!role) throw new ScoringError('not_found', `role ${input.role_id} not found`);
  const company = store.getCompany(role.company_id);
  if (!company) throw new ScoringError('not_found', `company ${role.company_id} not found`);
  const profile = store.getProfile(deps.profileVersionId);
  if (deps.profileVersionId && !profile) throw new ScoringError('not_found', `profile version ${deps.profileVersionId} not found`);
  const components = profile?.components ?? [];

  const rubric = rubricFor({ config, profileVersionId: profile?.id ?? null, components, scale: deps.scale });
  const facts = input.facts as ScoreFacts;
  const rawAffinity = affinityFor(company.slug, company.affinity, components);
  const computed = computeScore(input.criteria as Criteria, facts, rubric, components, rawAffinity, {
    location: role.location ?? null,
    workplace: role.workplace ?? null,
  });

  const movable = isMovable(role.status, role.archive_reason);
  const pool = store.companyPool(company.id).filter((p) => p.role_id !== role.id);
  let decision: ScoreDecision = computed.verdict;
  let cap: CapTransition[] = [];
  if (movable) {
    const cands = [...pool];
    if (computed.verdict === 'active') cands.push({ role_id: role.id, status: 'active', total: computed.total, found_at: role.found_at });
    const alloc = allocateCompanySlots(cands, rubric.company_active_cap);
    if (computed.verdict === 'active') decision = alloc.active.includes(role.id) ? 'active' : 'held';
    cap = capTransitions(poolMap(pool), alloc);
  }

  const now = ctx.now();
  const mkId = deps.newId ?? defaultNewId;
  const score: Score = {
    id: mkId(ID_PREFIX.score, now),
    role_id: role.id,
    profile_version_id: profile?.id ?? null,
    rubric_json: rubricSnapshot(rubric),
    ...(input.criteria as Criteria),
    affinity_mod: computed.affinity_mod,
    total: computed.total,
    band: computed.band,
    decision,
    facts_json: {
      ...input.facts,
      base_total: computed.base,
      affinity_raw: rawAffinity,
      dealbreaker_hits: computed.dealbreakers.hits,
      verify: computed.dealbreakers.verify,
      ...(movable ? {} : { status_kept: role.status }),
    },
    created_at: now.toISOString(),
  };

  const nextStatus: RoleStatus = movable ? decision : role.status;
  const eventIds: string[] = [];
  const output: OpOutput<'roles.score'> = {
    score,
    status: nextStatus,
    held: nextStatus === 'held',
    cap: cap.map(({ role_id, from, to }) => ({ role_id, from, to })),
  };
  if (ctx.dryRun) return { output, eventIds, cap };

  store.transaction(() => {
    const emit = emitter(deps, ctx, eventIds);
    store.insertScore(score);
    emit('role_scored', role.id, {
      score_id: score.id,
      total: score.total,
      band: score.band,
      decision,
      profile_version_id: score.profile_version_id,
      ...(movable ? {} : { status_kept: role.status }),
    });
    if (movable) {
      const archive_reason = nextStatus === 'archived' ? computed.archive_reason : null;
      const changed = nextStatus !== role.status || (nextStatus === 'archived' && archive_reason !== role.archive_reason);
      if (changed) {
        store.setStatus(
          role.id,
          nextStatus,
          { archive_reason, held_reason: nextStatus === 'held' ? 'company_cap' : null },
          now.toISOString(),
        );
        if (nextStatus === 'archived')
          emit('role_archived', role.id, { from: role.status, reason: archive_reason, hits: computed.dealbreakers.hits });
        else if (nextStatus === 'held') emit('role_held', role.id, { from: role.status, reason: 'company_cap', company_id: company.id });
        else if (role.status === 'held') emit('role_promoted', role.id, { from: 'held', to: 'active', company_id: company.id });
      }
      applyCapTransitions(deps, ctx, emit, cap, company.id);
    }
  });

  return { output: rolesScore.output.parse(output), eventIds, cap };
}

/**
 * Re-apply the per-company cap after something outside scoring frees or takes a slot
 * (roles.move / roles.archive / freshness close / inbox moves). Lane B's `moveRole` calls it after every move.
 */
export function rebalanceCompany(companyId: string, ctx: OpContext, deps: ScoringDeps): { cap: CapTransition[]; eventIds: string[] } {
  const pool = deps.store.companyPool(companyId);
  const cap = capTransitions(poolMap(pool), allocateCompanySlots(pool, deps.config.scoring.company_active_cap));
  const eventIds: string[] = [];
  if (cap.length === 0 || ctx.dryRun) return { cap, eventIds };
  deps.store.transaction(() => applyCapTransitions(deps, ctx, emitter(deps, ctx, eventIds), cap, companyId));
  return { cap, eventIds };
}
