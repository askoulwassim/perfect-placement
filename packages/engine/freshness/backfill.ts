import { type AskFn, DEFAULT_CONFIG, FRESHNESS_SCOPE, type OpContext, type RoleStatus } from '@perfect-placement/contracts';
import { atsTypeOf, detectAts, type FetchLike } from '../integrations/ats/index.js';
import { renderDryRunReport } from './report.js';
import { checkFreshness, type FreshnessRun } from './run.js';
import type { FreshnessStore, ScopeRole } from './store.js';

/** Read-only store over an in-memory role list (dry runs over sources that are not a v2 db). Every write throws. */
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
    attachDecisionAction: refuse,
    startRun: refuse,
    finishRun: refuse,
  };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

interface V1Role {
  id?: string;
  company?: string;
  role?: string;
  status?: string;
  url?: string | null;
}

/**
 * v1 `02_Pipeline/data/pipeline.json` -> ScopeRole[] (read-only input for a pre-migration dry run).
 * v1 has no found/posted dates, so the stale flag cannot fire from this source.
 */
export function rolesFromV1Pipeline(json: unknown): ScopeRole[] {
  const roles = (json as { roles?: V1Role[] })?.roles ?? [];
  return roles
    .filter((r) => r.status && (FRESHNESS_SCOPE as readonly string[]).includes(r.status))
    .map((r) => {
      const ref = detectAts(r.url);
      const companyName = r.company ?? 'unknown';
      return {
        id: r.id ?? `${slug(companyName)}_${slug(r.role ?? 'role')}`,
        title: r.role ?? '',
        url: r.url ?? null,
        status: r.status as RoleStatus,
        found_at: null,
        posted_at: null,
        freshness: 'unknown',
        last_checked_at: null,
        flags_json: {},
        company_id: slug(companyName),
        company_name: companyName,
        ats_type: atsTypeOf(r.url),
        ats_board: ref ? (ref.type === 'lever' ? ref.company : ref.board) : null,
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
