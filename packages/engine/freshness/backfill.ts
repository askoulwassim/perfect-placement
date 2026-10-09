import { type AskFn, DEFAULT_CONFIG, FRESHNESS_SCOPE, type OpContext } from '@perfect-placement/contracts';
import type { Db } from '../db/connection.js';
import { repos } from '../db/repo.js';
import type { FetchLike } from '../integrations/ats/index.js';
import { renderDryRunReport } from './report.js';
import { checkFreshness, type FreshnessRun } from './run.js';
import type { FreshnessStore, ScopeRole } from './store.js';

/** Read-only store over an in-memory role list (dry runs). Every write throws. */
export function memoryStore(roles: ScopeRole[]): FreshnessStore {
  const inScope = roles.filter((r) => (FRESHNESS_SCOPE as readonly string[]).includes(r.status));
  const refuse = () => {
    throw new Error('memoryStore is read-only (dry run)');
  };
  return {
    listInScope: (ids) => (ids ? inScope.filter((r) => ids.includes(r.id)) : inScope),
    recordCheck: refuse,
    archiveClosed: refuse,
    emit: refuse,
    startRun: refuse,
    finishRun: refuse,
  };
}

/** Roles in FRESHNESS_SCOPE from a pp.db, read through lane A repositories (dry runs; open the db read-only). */
export function rolesFromDb(db: Db): ScopeRole[] {
  const R = repos(db);
  const scope = FRESHNESS_SCOPE.map(() => '?').join(',');
  return R.role.select(`status IN (${scope}) ORDER BY id`, [...FRESHNESS_SCOPE]).map((r) => {
    const c = R.company.get(r.company_id);
    return {
      id: r.id,
      title: r.title,
      url: r.url,
      status: r.status,
      found_at: r.found_at,
      posted_at: r.posted_at,
      freshness: r.freshness,
      last_checked_at: r.last_checked_at,
      flags_json: r.flags_json,
      company_id: r.company_id,
      company_name: c?.name ?? r.company_id,
      ats_type: c?.ats_type ?? null,
      ats_board: c?.ats_board ?? null,
    };
  });
}

const noAsk: AskFn = () => Promise.reject(new Error('dry run never calls the resolver'));

export interface DryRunOptions {
  fetch: FetchLike;
  now?: () => Date;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  limit?: number;
  staleAfterDays?: number;
}

/** Backfill dry run: the first daily run without writes or resolver calls. Returns rows + a markdown report. */
export async function backfillDryRun(
  store: FreshnessStore,
  source: string,
  opts: DryRunOptions,
): Promise<FreshnessRun & { report: string }> {
  const now = opts.now ?? (() => new Date());
  let ids: string[] | undefined;
  if (opts.limit !== undefined) ids = (await store.listInScope()).slice(0, opts.limit).map((r) => r.id);
  const ctx: OpContext = { actor: 'schedule', now, dryRun: true };
  const run = await checkFreshness(ids ? { role_ids: ids } : { all_in_scope: true }, ctx, {
    store,
    fetch: opts.fetch,
    ask: noAsk,
    config: { freshness: { stale_after_days: opts.staleAfterDays ?? DEFAULT_CONFIG.freshness.stale_after_days } },
    delayMs: opts.delayMs,
    sleep: opts.sleep,
  });
  return { ...run, report: renderDryRunReport(run.rows, run.summary, { source, at: now().toISOString() }) };
}
