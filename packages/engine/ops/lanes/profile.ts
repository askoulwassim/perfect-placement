import { CRITERIA, type Criterion, type OpContext } from '@perfect-placement/contracts';
import type { ProfileDeps } from '../../profile/deps.js';
import { RequiresHuman } from '../../profile/errors.js';
import { learnFromEvent } from '../../profile/learn.js';
import {
  onboardAnswer,
  onboardCalibrate,
  onboardConfirm,
  onboardIngestResume,
  onboardSamples,
  onboardStart,
  onboardState,
} from '../../profile/onboard.js';
import { createDbOnboardStore } from '../../profile/onboard-store.js';
import {
  profileApplyDiff,
  profileGet,
  profileHistory,
  profileProposeDiff,
  profileRejectDiff,
  undoDiff,
} from '../../profile/profile-ops.js';
import { defineHandler, type HandlerContext, requiresHuman } from '../runtime.js';

/*
 * Lane E wiring: every profile.* and onboard.* op, with ProfileDeps built from the op's context
 * (lane A repos, runOp's emitter + staged vault, this op's resolver, nested ops). Applied weighted
 * and filter diffs rescore the affected roles through lane F (`roles.score`, nested).
 */

/** Keys the scorer adds to facts_json; a rescore starts again from the judged facts. */
const COMPUTED_FACTS = ['base_total', 'affinity_raw', 'verify', 'status_kept', 'dealbreaker_hits'];

/** Rescore roles under a new profile version with their latest judged criteria (lane F, nested ops). */
export async function rescoreRoles(
  h: HandlerContext,
  roleIds: readonly string[],
  versionId: string,
  ctx: OpContext = h.ctx,
): Promise<string[]> {
  const done: string[] = [];
  for (const id of roleIds) {
    const s = h.repos.score.select('role_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', [id])[0];
    if (!s) continue;
    const facts = Object.fromEntries(Object.entries(s.facts_json).filter(([k]) => !COMPUTED_FACTS.includes(k)));
    // Only the judged hard nos carry over; computed hits are recomputed against the new profile.
    const judged = ((s.facts_json.dealbreaker_hits as unknown[] | undefined) ?? [])
      .filter((x): x is string => typeof x === 'string' && x.startsWith('judged:'))
      .map((x) => x.slice('judged:'.length));
    if (judged.length) facts.dealbreaker_hits = judged;
    const criteria = Object.fromEntries(CRITERIA.map((c) => [c, s[c]])) as Record<Criterion, number>;
    const o = await h.runOp(
      'roles.score',
      { role_id: id, criteria, facts, profile_version_id: versionId },
      { ...ctx, decisionId: undefined },
    );
    if (o.status === 'ok') done.push(id);
  }
  return done;
}

export function profileDeps(h: HandlerContext): ProfileDeps {
  return {
    repos: h.repos,
    emit: (ev) => h.emit(ev.type, ev.subject_type, ev.subject_id, ev.payload, ev.decision_id),
    ask: (req) => h.resolver.ask(req, { actor: h.ctx.actor }),
    ...(h.services.profileLlm ? { llm: h.services.profileLlm } : {}),
    config: h.config,
    vault: { read: (rel) => h.vault.read(rel), write: (rel, content) => h.vault.write(rel, content) },
    onboardStore: createDbOnboardStore(h.repos),
    rescore: (ids, versionId) => rescoreRoles(h, ids, versionId),
    runOp: h.runOp,
  };
}

/** Lane E signals a human decision by throwing; runOp wants a value. */
async function routed<T>(fn: () => T | Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RequiresHuman) return requiresHuman(e.decisionId);
    throw e;
  }
}

export const LANE_E_HANDLERS = {
  'profile.get': defineHandler('profile.get', { run: (i, h) => profileGet(profileDeps(h), i) }),
  'profile.history': defineHandler('profile.history', { run: (i, h) => profileHistory(profileDeps(h), i) }),
  'profile.propose_diff': defineHandler('profile.propose_diff', { run: (i, h) => profileProposeDiff(profileDeps(h), i, h.ctx).output }),
  'profile.apply_diff': defineHandler('profile.apply_diff', {
    decisionKind: 'profile.apply_diff',
    run: (i, h) => routed(async () => (await profileApplyDiff(profileDeps(h), i, h.ctx)).output),
  }),
  'profile.reject_diff': defineHandler('profile.reject_diff', { run: (i, h) => profileRejectDiff(profileDeps(h), i, h.ctx).output }),
  'profile.undo_diff': defineHandler('profile.undo_diff', { run: (i, h) => undoDiff(profileDeps(h), i.diff_id, h.ctx) }),
  'profile.learn': defineHandler('profile.learn', {
    async run(i, h) {
      const r = await learnFromEvent(profileDeps(h), i.event_id, h.ctx);
      return {
        proposed: r.proposed,
        applied: r.applied.map(({ diff_id, version_id }) => ({ diff_id, version_id })),
        queued: r.queued.map(({ diff_id, decision_id }) => ({ diff_id, decision_id })),
      };
    },
  }),
  'onboard.start': defineHandler('onboard.start', { run: (i, h) => onboardStart(profileDeps(h), i, h.ctx) }),
  'onboard.state': defineHandler('onboard.state', { run: (_i, h) => onboardState(profileDeps(h)) }),
  'onboard.samples': defineHandler('onboard.samples', { run: (_i, h) => onboardSamples(profileDeps(h)) }),
  'onboard.ingest_resume': defineHandler('onboard.ingest_resume', { run: (i, h) => onboardIngestResume(profileDeps(h), i, h.ctx) }),
  'onboard.answer': defineHandler('onboard.answer', { run: (i, h) => onboardAnswer(profileDeps(h), i, h.ctx) }),
  'onboard.calibrate': defineHandler('onboard.calibrate', { run: (i, h) => onboardCalibrate(profileDeps(h), i, h.ctx) }),
  'onboard.confirm': defineHandler('onboard.confirm', { run: (i, h) => onboardConfirm(profileDeps(h), i, h.ctx) }),
} as const;
