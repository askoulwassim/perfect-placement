import { join } from 'node:path';
import { DB_FILE } from '@perfect-placement/contracts';
import { openDb } from './_shim/db.js';
import { LANE_B_HANDLERS } from './handlers/index.js';
import type { DecisionPort } from './ports.js';
import { createEngine, type Engine, type HandlerMap } from './runtime.js';
import { resolveHome } from './vault.js';

/*
 * Lane B: the ops runtime (`runOp`) and every lane B handler.
 * Other lanes plug in with `engine.register(name, handler)` (see runtime.ts OpHandler).
 */

export const OWNER_LANE = 'B' as const;

export { applyMigrations, openDb } from './_shim/db.js';
export { shimDecide, shimDecisions } from './_shim/decisions.js';
export { EXTRA_OPS, type ExtraOpName, runsFinish as runsFinishOp } from './_shim/extra-ops.js';
export * from './dedupe.js';
export { notFound, OpError } from './errors.js';
export { INBOX_TARGET } from './handlers/inbox.js';
export { LANE_B_HANDLERS, NOT_LANE_B } from './handlers/index.js';
export { appendRoleLog, latestScore, type MoveOptions, moveRole, promoteHeld, upsertApplication } from './handlers/shared.js';
export { newId, roleIdFor, slugify, ulid } from './ids.js';
export type { DecisionAction, DecisionPort, RecordDecisionRequest, RecordDecisionResult } from './ports.js';
export {
  ALL_OPS,
  type AnyOpName,
  createEngine,
  defineHandler,
  type Engine,
  type EngineDeps,
  type HandlerContext,
  type HandlerInput,
  type HandlerMap,
  type HandlerOutput,
  type OpHandler,
  type PrepareContext,
  type RequiresHuman,
  type RunLogEntry,
  requiresHuman,
} from './runtime.js';
export { deepMerge, readConfig, renderMarkdown, resolveHome, stripFrontmatter, VaultTx } from './vault.js';

export interface OpenEngineOptions {
  /** Vault root. Defaults to PP_HOME / ~/.perfect-placement. */
  home?: string;
  decisions?: DecisionPort;
  /** Extra handlers (other lanes) layered over lane B's. */
  handlers?: HandlerMap;
}

/** Open `$PP_HOME/pp.db` (applying pending migrations) and build an engine with lane B handlers. */
export function openEngine(opts: OpenEngineOptions = {}): Engine & { close(): void } {
  const home = opts.home ?? resolveHome();
  const db = openDb(join(home, DB_FILE));
  const engine = createEngine({
    db,
    home,
    handlers: { ...LANE_B_HANDLERS, ...(opts.handlers ?? {}) },
    ...(opts.decisions ? { decisions: opts.decisions } : {}),
  });
  return Object.assign(engine, { close: () => db.close() });
}
