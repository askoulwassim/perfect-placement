import { LANE_B_HANDLERS } from './handlers/index.js';
import { decisionsQueue, decisionsResolve, decisionsUndo, decisionsUndoGroup, systemBackends, systemDoctor } from './lanes/decisions.js';
import { rolesCheckFreshness } from './lanes/freshness.js';
import { LANE_H_HANDLERS } from './lanes/people.js';
import { LANE_E_HANDLERS } from './lanes/profile.js';
import { rolesReevaluateFilters, rolesScore } from './lanes/scoring.js';
import type { HandlerMap } from './runtime.js';

/**
 * Every op with its handler (lanes A, B, E, F, G, H, I). `outreach.send` has none: it is
 * unimplemented by contract and runOp answers `unimplemented`.
 */
export const ALL_HANDLERS: HandlerMap = {
  ...LANE_B_HANDLERS,
  ...LANE_E_HANDLERS,
  'roles.score': rolesScore,
  'roles.reevaluate_filters': rolesReevaluateFilters,
  'roles.check_freshness': rolesCheckFreshness,
  ...LANE_H_HANDLERS,
  'decisions.queue': decisionsQueue,
  'decisions.resolve': decisionsResolve,
  'decisions.undo': decisionsUndo,
  'decisions.undo_group': decisionsUndoGroup,
  'system.backends': systemBackends,
  'system.doctor': systemDoctor,
};
