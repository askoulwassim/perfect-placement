import { join } from 'node:path';
import { DB_FILE } from '@perfect-placement/contracts';
import { openDb } from '../db/connection.js';
import { initVault } from '../db/vault.js';
import { ALL_HANDLERS } from './registry.js';
import { createEngine, type Engine, type HandlerMap } from './runtime.js';
import type { EngineServices } from './services.js';
import { resolveHome } from './vault.js';

/*
 * The ops runtime (`runOp`) and every handler. `openEngine()` is the one factory the surfaces
 * (pp CLI, `pp up` HTTP API, MCP stdio/HTTP, schedules) call.
 */

export const OWNER_LANE = 'B' as const;

export { createDecisionStore } from './decision-store.js';
export * from './dedupe.js';
export { notFound, OpError } from './errors.js';
export { INBOX_TARGET } from './handlers/inbox.js';
export { LANE_B_HANDLERS } from './handlers/index.js';
export { appendRoleLog, latestScore, type MoveOptions, moveRole, undoMove, upsertApplication } from './handlers/shared.js';
export { newId, roleIdFor, slugify, ulid } from './ids.js';
export { backendStatus } from './lanes/decisions.js';
export { rebalance, scoringStore } from './lanes/scoring.js';
export { changedKeys, hardHumanHint } from './policy.js';
export { ALL_HANDLERS } from './registry.js';
export {
  buildRunnerSpec,
  CELLAR_NODE,
  createSpawnLauncher,
  cursorPermissions,
  DEFAULT_SKILLS_DIR,
  defaultMcpServer,
  deniedTools,
  deniedToolsError,
  MCP_SERVER_NAME,
  type McpServerSpec,
  pidAlive,
  type RunnerExit,
  type RunnerLauncher,
  type RunnerSpec,
  resolveRepoRoot,
  runnerAlive,
  runnerDir,
  SKILL_ASSETS,
  SKILL_TOOLS,
  skillAllowedTools,
  skillPrompt,
  stableNodePath,
  type WebTool,
} from './runner.js';
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
export type { EngineServices } from './services.js';
export { INTERRUPTED, interruptStaleRuns, type StaleRunOptions } from './stale-runs.js';
export { deepMerge, readConfig, renderMarkdown, resolveHome, stripFrontmatter, VaultTx } from './vault.js';

export interface OpenEngineOptions {
  /** Vault root. Defaults to PP_HOME / ~/.perfect-placement. */
  home?: string;
  /** Network adapters, resolver backends, runner launcher (defaults: real ones). */
  services?: EngineServices;
  /** Extra or replacement handlers layered over ALL_HANDLERS (tests). */
  handlers?: HandlerMap;
}

/** Open `$PP_HOME/pp.db` (creating the vault and applying pending migrations) and build the engine. */
export function openEngine(opts: OpenEngineOptions = {}): Engine & { close(): void } {
  const home = opts.home ?? resolveHome();
  initVault(home);
  const db = openDb(join(home, DB_FILE));
  const engine = createEngine({ db, home, handlers: { ...ALL_HANDLERS, ...(opts.handlers ?? {}) }, services: opts.services ?? {} });
  return Object.assign(engine, { close: () => db.close() });
}
