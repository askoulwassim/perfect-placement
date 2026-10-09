import type { OpContext } from '@perfect-placement/contracts';
import type { ProfileDeps } from '../../profile/deps.js';
import { RequiresHuman } from '../../profile/errors.js';
import { learnFromEvent } from '../../profile/learn.js';
import {
  onboardAnswer,
  onboardCalibrate,
  onboardConfirm,
  onboardExtract,
  onboardIngestResume,
  onboardProposeQuestions,
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
  profileSetDefaults,
  undoDiff,
} from '../../profile/profile-ops.js';
import { defineHandler, type HandlerContext, requiresHuman } from '../runtime.js';
import { rescoreInputOf } from './scoring.js';

/*
 * Lane E wiring: every profile.* and onboard.* op, with ProfileDeps built from the op's context
 * (lane A repos, runOp's emitter + staged vault, this op's resolver, nested ops). Applied weighted
 * and filter diffs rescore the affected roles through lane F (`roles.score`, nested).
 */

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
    const { criteria, facts } = rescoreInputOf(s);
    const o = await h.runOp(
      'roles.score',
      { role_id: id, criteria, facts, profile_version_id: versionId, rescore: true },
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
    vault: {
      read: (rel) => h.vault.read(rel),
      write: (rel, content) => h.vault.write(rel, content),
      writeBytes: (rel, content) => h.vault.writeBytes(rel, content),
      readBytes: (rel) => h.vault.readBytes(rel),
    },
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
  'profile.set_defaults': defineHandler('profile.set_defaults', {
    run: (i, h) => routed(() => profileSetDefaults(profileDeps(h), i, h.ctx)),
  }),
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
  'onboard.extract': defineHandler('onboard.extract', { run: (i, h) => onboardExtract(profileDeps(h), i, h.ctx) }),
  'onboard.propose_questions': defineHandler('onboard.propose_questions', {
    run: (i, h) => onboardProposeQuestions(profileDeps(h), i, h.ctx),
  }),
} as const;
