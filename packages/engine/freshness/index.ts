// Lane G. Daily freshness: ATS API -> page -> resolver Noulli. Outcomes open / closed / unsure, stale flag.
import { OPS, type OpContext } from '@perfect-placement/contracts';
import { type CheckFreshnessOutput, checkFreshness, type FreshnessDeps } from './run.js';

export const OWNER_LANE = 'G' as const;

export { backfillDryRun, type DryRunOptions, memoryStore, rolesFromV1Pipeline } from './backfill.js';
export { newId, ulid } from './ids.js';
export { assess, type Evidence, type LadderTarget } from './ladder.js';
export { CLOSED_PHRASES, checkPage, closedPhrase, isListingRedirect, type PageCheck, type PageSignal } from './page.js';
export { renderDryRunReport, renderRunLog } from './report.js';
export {
  ageDays,
  type CheckFreshnessInput,
  type CheckFreshnessOutput,
  checkFreshness,
  type FreshnessDeps,
  type FreshnessResult,
  type FreshnessRow,
  type FreshnessRun,
  type FreshnessSummary,
  OPEN_QUESTION,
  RUN_OP,
  summarize,
} from './run.js';
export { sqliteStore } from './sqlite-store.js';
export type { FreshnessEvent, FreshnessStore, ScopeRole } from './store.js';

/**
 * Handler for `roles.check_freshness`, ready for lane B's registry: validates input and output
 * against the contract. Wave 2 binds `deps` (ops-backed store, resolver ask, fetch, config).
 */
export function rolesCheckFreshnessHandler(deps: FreshnessDeps) {
  const def = OPS['roles.check_freshness'];
  return async (input: unknown, ctx: OpContext): Promise<CheckFreshnessOutput> => {
    const parsed = def.input.parse(input);
    const run = await checkFreshness(parsed, ctx, deps);
    return def.output.parse(run.output);
  };
}
