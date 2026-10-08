import {
  type AskResult,
  type Impact,
  type OpContext,
  type OpInput,
  type OpOutput,
  PROFILE_COMPONENT_KIND,
  type ProfileComponentKey,
  type ProfileDiff,
  type ProfileVersion,
} from '@perfect-placement/contracts';
import { type CriteriaWeights, criteriaOwnedBy, impactForComponent, isHumanOnlyComponent, safeParseComponentData } from './components.js';
import { newId, type ProfileDeps } from './deps.js';
import { OpError, RequiresHuman } from './errors.js';
import { clone, deepEqual } from './json.js';
import {
  getComponent,
  getComponents,
  getCurrentVersion,
  getDiff,
  getVersion,
  insertDiff,
  insertVersion,
  listDiffs,
  listVersions,
  rescoreScope,
  updateDiff,
} from './store.js';

/*
 * profile.get, profile.history, profile.propose_diff, profile.apply_diff, profile.reject_diff
 * plus undoDiff (needed by decisions.undo for auto + undo diffs; see CONTRACT_CHANGES lane E).
 *
 * Diff semantics: diff_json = { before, after } over the component's data_json, top-level keys only.
 *  - keys in `after` are set to the after value;
 *  - keys in `before` but not in `after` are removed.
 * A diff applies if its base version is still current, or else if the current values of its
 * keys still equal `before` (else `conflict`). Undo restores `before` the same way.
 */

const IMPACT_RANK: Record<Impact, number> = { low: 0, medium: 1, high: 2 };
const maxImpact = (a: Impact, b: Impact): Impact => (IMPACT_RANK[a] >= IMPACT_RANK[b] ? a : b);

export function applyPatch(
  data: Record<string, unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const out = clone(data);
  for (const [k, v] of Object.entries(after)) out[k] = clone(v);
  for (const k of Object.keys(before)) if (!(k in after)) delete out[k];
  return out;
}

function currentValues(data: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in data) out[k] = clone(data[k]);
  return out;
}

function requireCurrent(deps: ProfileDeps): ProfileVersion {
  const v = getCurrentVersion(deps.db);
  if (!v) throw new OpError('not_found', 'no profile yet: run onboarding first');
  return v;
}

// ------------------------------------------------------------------ reads

export function profileGet(deps: ProfileDeps, input: OpInput<'profile.get'>): OpOutput<'profile.get'> {
  const version = input.version_id ? getVersion(deps.db, input.version_id) : getCurrentVersion(deps.db);
  if (!version) throw new OpError('not_found', input.version_id ? `version ${input.version_id} not found` : 'no profile yet');
  return { version, components: getComponents(deps.db, version.id), pending_diffs: listDiffs(deps.db, 'pending') };
}

/** All versions; with `component`, only the versions where that component changed (root included). */
export function profileHistory(deps: ProfileDeps, input: OpInput<'profile.history'>): OpOutput<'profile.history'> {
  const versions = listVersions(deps.db);
  const key = input.component;
  if (!key) return { versions };
  return {
    versions: versions.filter((v) => {
      if (!v.parent_id) return true;
      const a = getComponent(deps.db, v.id, key);
      const b = getComponent(deps.db, v.parent_id, key);
      return !b || !a || !deepEqual([a.data_json, a.confidence, a.weight], [b.data_json, b.confidence, b.weight]);
    }),
  };
}

// ------------------------------------------------------------------ propose

export function profileProposeDiff(
  deps: ProfileDeps,
  input: OpInput<'profile.propose_diff'>,
  ctx: OpContext,
): { output: OpOutput<'profile.propose_diff'>; eventIds: string[] } {
  const version = requireCurrent(deps);
  const comp = getComponent(deps.db, version.id, input.component);
  if (!comp) throw new OpError('not_found', `component ${input.component} missing on ${version.id}`);
  const keys = [...new Set([...Object.keys(input.before), ...Object.keys(input.after)])];
  const actual = currentValues(comp.data_json, keys);
  const claimed = currentValues(input.before, keys);
  if (!deepEqual(actual, claimed)) {
    throw new OpError('conflict', `'before' does not match the current ${input.component} data`, { expected: actual });
  }
  const next = applyPatch(comp.data_json, input.before, input.after);
  if (deepEqual(next, comp.data_json)) throw new OpError('invalid_input', 'diff changes nothing');
  const parsed = safeParseComponentData(input.component, next);
  if (!parsed.success) throw new OpError('invalid_input', `result is not valid ${input.component} data`, parsed.error.issues);

  const now = ctx.now();
  const diff: ProfileDiff = {
    id: newId('pd', now),
    created_at: now.toISOString(),
    component_key: input.component,
    base_version_id: version.id,
    diff_json: { before: clone(input.before), after: clone(input.after) },
    evidence_json: [...input.evidence],
    impact: impactForComponent(input.component),
    status: 'pending',
    decision_id: null,
    event_id: input.event_id ?? null,
    applied_version_id: null,
  };
  if (ctx.dryRun) return { output: { diff }, eventIds: [] };
  insertDiff(deps.db, diff);
  const evId = deps.emit(
    {
      type: 'profile_diff_proposed',
      subject_type: 'profile_diff',
      subject_id: diff.id,
      payload: { component: diff.component_key, impact: diff.impact, cause_event_id: input.event_id ?? null },
      actor: ctx.actor,
    },
    now,
  );
  // event_id = causing event when given, else the proposal event (matches fixtures).
  if (!diff.event_id) {
    diff.event_id = evId;
    updateDiff(deps.db, diff.id, { event_id: evId });
  }
  return { output: { diff }, eventIds: [evId] };
}

// ------------------------------------------------------------------ apply

/** Effective impact: never lower than what the component kind implies (guards a tampered row). */
export function diffImpact(diff: ProfileDiff): Impact {
  return maxImpact(diff.impact, impactForComponent(diff.component_key));
}

/** True when ctx carries an explicit human approval: a human actor, or a resolved decision a human chose. */
function humanApproved(deps: ProfileDeps, ctx: OpContext): boolean {
  if (ctx.actor === 'human') return true;
  if (!ctx.decisionId) return false;
  const row = deps.db.prepare('SELECT human_choice, resolved_at, policy_outcome FROM decision WHERE id = ?').get(ctx.decisionId) as
    | { human_choice: string | null; resolved_at: string | null; policy_outcome: string }
    | undefined;
  return !!row && row.policy_outcome === 'human' && (row.human_choice != null || row.resolved_at != null);
}

/** Auto outcome from the resolver (low/medium only). */
function autoApproved(deps: ProfileDeps, ctx: OpContext, impact: Impact): boolean {
  if (impact === 'high' || !ctx.decisionId) return false;
  const row = deps.db.prepare('SELECT policy_outcome, answer_json FROM decision WHERE id = ?').get(ctx.decisionId) as
    | { policy_outcome: string; answer_json: string }
    | undefined;
  if (!row || row.policy_outcome === 'human') return false;
  const ans = JSON.parse(row.answer_json) as { value?: unknown };
  return ans.value === true;
}

/**
 * Ask the resolver whether to apply a pending diff. Links the decision to the diff.
 * Returns the outcome; never applies anything itself.
 */
export async function routeDiff(
  deps: ProfileDeps,
  diff: ProfileDiff,
  ctx: OpContext,
): Promise<{ result: AskResult; decisionId: string; outcome: AskResult['outcomes'][number]; value: unknown; p: number }> {
  if (!deps.ask) throw new OpError('backend_unavailable', 'resolver not configured');
  const impact = diffImpact(diff);
  const d = diff.diff_json as { before?: unknown; after?: unknown };
  const result = await deps.ask({
    decision: 'profile.apply_diff',
    impact,
    state: {
      component: diff.component_key,
      kind: PROFILE_COMPONENT_KIND[diff.component_key],
      before: JSON.stringify(d.before ?? {}),
      after: JSON.stringify(d.after ?? {}),
      evidence: diff.evidence_json.join('\n'),
    },
    questions: [
      { id: 'apply', type: 'noulli', instructions: `Apply this change to the ${diff.component_key.replace('_', ' ')} component?` },
    ],
    subject: { type: 'profile_diff', id: diff.id },
  });
  const decisionId = result.decisionIds[0];
  const answer = result.answers[0];
  let outcome = result.outcomes[0];
  if (!decisionId || !answer || !outcome) throw new OpError('internal', 'resolver returned no answer');
  // Belt and braces: whatever the resolver says, filters and dealbreakers go to a human.
  if (impact === 'high') outcome = 'human';
  deps.attachAction?.(decisionId, { op: 'profile.apply_diff', input: { diff_id: diff.id } });
  if (!ctx.dryRun) updateDiff(deps.db, diff.id, { decision_id: decisionId });
  return { result, decisionId, outcome, value: answer.value, p: answer.p };
}

/**
 * Apply a pending diff -> profile v+1. Routing:
 *  - human actor, or a human-resolved decision in ctx: apply.
 *  - high impact (filters, dealbreakers) otherwise: requires_human. Never auto-applied.
 *  - low/medium from an agent: resolver decides (auto, auto_second, auto_undo apply; human queues).
 */
export async function profileApplyDiff(
  deps: ProfileDeps,
  input: OpInput<'profile.apply_diff'>,
  ctx: OpContext,
): Promise<{ output: OpOutput<'profile.apply_diff'>; eventIds: string[] }> {
  const diff = getDiff(deps.db, input.diff_id);
  if (!diff) throw new OpError('not_found', `diff ${input.diff_id} not found`);
  if (diff.status !== 'pending') throw new OpError('conflict', `diff ${diff.id} is ${diff.status}`);
  const impact = diffImpact(diff);

  if (!humanApproved(deps, ctx)) {
    if (impact === 'high' || isHumanOnlyComponent(diff.component_key)) {
      if (diff.decision_id) throw new RequiresHuman(diff.decision_id);
      if (deps.ask) throw new RequiresHuman((await routeDiff(deps, diff, ctx)).decisionId);
      throw new OpError('human_only', `${diff.component_key} changes need a human`);
    }
    if (!autoApproved(deps, ctx, impact)) {
      const r = await routeDiff(deps, diff, ctx);
      if (r.outcome === 'human' || r.value !== true) throw new RequiresHuman(r.decisionId);
      ctx = { ...ctx, decisionId: r.decisionId };
    }
  }
  return applyApproved(deps, diff, ctx);
}

/** Mechanics only: caller has established approval. */
export async function applyApproved(
  deps: ProfileDeps,
  diff: ProfileDiff,
  ctx: OpContext,
): Promise<{ output: OpOutput<'profile.apply_diff'>; eventIds: string[] }> {
  const now = ctx.now();
  const version = requireCurrent(deps);
  const comp = getComponent(deps.db, version.id, diff.component_key);
  if (!comp) throw new OpError('not_found', `component ${diff.component_key} missing`);
  const { before = {}, after = {} } = diff.diff_json as { before?: Record<string, unknown>; after?: Record<string, unknown> };
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  // Fresh when the base is still current; otherwise the touched keys must still hold `before`.
  if (diff.base_version_id !== version.id && !deepEqual(currentValues(comp.data_json, keys), currentValues(before, keys))) {
    throw new OpError('conflict', `diff ${diff.id} is stale: ${diff.component_key} changed since ${diff.base_version_id}`);
  }
  const data = applyPatch(comp.data_json, before, after);
  const parsed = safeParseComponentData(diff.component_key, data);
  if (!parsed.success) throw new OpError('invalid_input', 'diff result is invalid', parsed.error.issues);

  let weight = comp.weight;
  const cw = data.criterion_weights as CriteriaWeights | undefined;
  if (comp.kind === 'weighted' && cw)
    weight = Math.round(criteriaOwnedBy(diff.component_key).reduce((s, c) => s + (cw[c] ?? 0), 0) * 100) / 10000;

  if (ctx.dryRun) {
    return {
      output: {
        version: {
          id: 'dry_run',
          created_at: now.toISOString(),
          parent_id: version.id,
          reason: `diff ${diff.id}`,
          event_id: diff.event_id,
        },
        rescored_role_ids: [],
      },
      eventIds: [],
    };
  }
  const { version: next } = insertVersion(deps.db, {
    now,
    parent_id: version.id,
    reason: `diff ${diff.id}: ${diff.component_key}`,
    event_id: diff.event_id,
    drafts: {
      [diff.component_key]: { key: diff.component_key, confidence: comp.confidence, weight, data_json: data, md_path: comp.md_path },
    },
  });
  updateDiff(deps.db, diff.id, {
    status: 'applied',
    applied_version_id: next.id,
    ...(ctx.decisionId ? { decision_id: ctx.decisionId } : {}),
  });
  const evId = deps.emit(
    {
      type: 'profile_diff_applied',
      subject_type: 'profile_diff',
      subject_id: diff.id,
      payload: { component: diff.component_key, version_id: next.id, parent_id: version.id },
      actor: ctx.actor,
      decision_id: ctx.decisionId ?? diff.decision_id,
    },
    now,
  );
  // Asset changes (story, voice, network) do not change scores.
  const scope = comp.kind === 'asset' ? [] : rescoreScope(deps.db);
  const rescored = deps.rescore ? await deps.rescore(scope, next.id) : scope;
  return { output: { version: next, rescored_role_ids: rescored }, eventIds: [evId] };
}

// ------------------------------------------------------------------ reject / undo

export function profileRejectDiff(
  deps: ProfileDeps,
  input: OpInput<'profile.reject_diff'>,
  ctx: OpContext,
): { output: OpOutput<'profile.reject_diff'>; eventIds: string[] } {
  const diff = getDiff(deps.db, input.diff_id);
  if (!diff) throw new OpError('not_found', `diff ${input.diff_id} not found`);
  if (diff.status !== 'pending') throw new OpError('conflict', `diff ${diff.id} is ${diff.status}`);
  if (ctx.dryRun) return { output: { ok: true }, eventIds: [] };
  const now = ctx.now();
  updateDiff(deps.db, diff.id, { status: 'rejected' });
  const evId = deps.emit(
    {
      type: 'profile_diff_rejected',
      subject_type: 'profile_diff',
      subject_id: diff.id,
      payload: { component: diff.component_key, reason: input.reason ?? null },
      actor: ctx.actor,
      decision_id: ctx.decisionId ?? null,
    },
    now,
  );
  return { output: { ok: true }, eventIds: [evId] };
}

/**
 * Undo an applied diff (auto + undo window): new version restoring `before` on the diff's keys.
 * Not an op in the contract yet; lane I's decisions.undo calls this (CONTRACT_CHANGES lane E).
 */
export async function undoDiff(deps: ProfileDeps, diffId: string, ctx: OpContext): Promise<{ version: ProfileVersion }> {
  const diff = getDiff(deps.db, diffId);
  if (!diff) throw new OpError('not_found', `diff ${diffId} not found`);
  if (diff.status !== 'applied') throw new OpError('conflict', `diff ${diffId} is ${diff.status}`);
  const version = requireCurrent(deps);
  const comp = getComponent(deps.db, version.id, diff.component_key as ProfileComponentKey);
  if (!comp) throw new OpError('not_found', 'component missing');
  const { before = {}, after = {} } = diff.diff_json as { before?: Record<string, unknown>; after?: Record<string, unknown> };
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  if (diff.applied_version_id !== version.id && !deepEqual(currentValues(comp.data_json, keys), currentValues(after, keys))) {
    throw new OpError('conflict', `cannot undo ${diffId}: ${diff.component_key} changed after it was applied`);
  }
  // Exact restore when nothing came after the diff; else reverse-patch the touched keys.
  const prior =
    diff.applied_version_id === version.id && version.parent_id ? getComponent(deps.db, version.parent_id, diff.component_key) : null;
  const data = prior ? clone(prior.data_json) : applyPatch(comp.data_json, after, before);
  const parent = diff.applied_version_id ? getComponent(deps.db, diff.applied_version_id, diff.component_key) : null;
  const base = getComponent(deps.db, diff.base_version_id, diff.component_key);
  const now = ctx.now();
  const { version: next } = insertVersion(deps.db, {
    now,
    parent_id: version.id,
    reason: `undo ${diff.id}: ${diff.component_key}`,
    event_id: diff.event_id,
    drafts: {
      [diff.component_key]: {
        key: diff.component_key,
        confidence: comp.confidence,
        weight: base?.weight ?? parent?.weight ?? comp.weight,
        data_json: data,
        md_path: comp.md_path,
      },
    },
  });
  updateDiff(deps.db, diff.id, { status: 'undone' });
  return { version: next };
}
