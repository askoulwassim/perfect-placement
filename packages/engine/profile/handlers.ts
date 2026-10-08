import { OPS, type OpContext, type OpOutcome } from '@perfect-placement/contracts';
import type { ProfileDeps } from './deps.js';
import { toOutcome } from './errors.js';
import { onboardAnswer, onboardCalibrate, onboardConfirm, onboardIngestResume } from './onboard.js';
import { profileApplyDiff, profileGet, profileHistory, profileProposeDiff, profileRejectDiff } from './profile-ops.js';

/*
 * Lane E op handlers, keyed by op name. Each validates input and output against the
 * contract and returns an OpOutcome. Wave 2: lane B registers these in runOp (which then
 * owns validation + event writing; these handlers already emit through deps.emit).
 */

export const LANE_E_OPS = [
  'profile.get',
  'profile.history',
  'profile.propose_diff',
  'profile.apply_diff',
  'profile.reject_diff',
  'onboard.ingest_resume',
  'onboard.answer',
  'onboard.calibrate',
  'onboard.confirm',
] as const;
export type LaneEOp = (typeof LANE_E_OPS)[number];

export type Handler = (input: unknown, ctx: OpContext) => Promise<OpOutcome<unknown>>;

type Impl = (deps: ProfileDeps, input: never, ctx: OpContext) => unknown;

const IMPLS: Record<LaneEOp, Impl> = {
  'profile.get': (d, i) => ({ output: profileGet(d, i), eventIds: [] }),
  'profile.history': (d, i) => ({ output: profileHistory(d, i), eventIds: [] }),
  'profile.propose_diff': (d, i, c) => profileProposeDiff(d, i, c),
  'profile.apply_diff': (d, i, c) => profileApplyDiff(d, i, c),
  'profile.reject_diff': (d, i, c) => profileRejectDiff(d, i, c),
  'onboard.ingest_resume': async (d, i, c) => ({ output: await onboardIngestResume(d, i, c), eventIds: [] }),
  'onboard.answer': (d, i, c) => ({ output: onboardAnswer(d, i, c), eventIds: [] }),
  'onboard.calibrate': (d, i, c) => ({ output: onboardCalibrate(d, i, c), eventIds: [] }),
  'onboard.confirm': (d, i, c) => ({ output: onboardConfirm(d, i, c), eventIds: [] }),
};

export function createProfileHandlers(deps: ProfileDeps): Record<LaneEOp, Handler> {
  const out = {} as Record<LaneEOp, Handler>;
  for (const name of LANE_E_OPS) {
    out[name] = async (raw, ctx) => {
      try {
        const def = OPS[name];
        const input = def.input.parse(raw);
        const { output, eventIds } = (await IMPLS[name](deps, input as never, ctx)) as { output: unknown; eventIds: string[] };
        return { status: 'ok', output: def.output.parse(output), eventIds };
      } catch (err) {
        return toOutcome(err);
      }
    };
  }
  return out;
}
