/*
 * Scout source mix (blueprint "Scoring v2"): watchlist career pages are at most
 * `config.scout.watchlist_share_max` of a run's queries. The watchlist comes from the Company component.
 * The scout skill proposes queries (judgment); this trims them (mechanics). See skills/scout/plan.md.
 */

export interface ScoutQuery {
  kind: 'watchlist' | 'open';
  /** Company slug for watchlist queries. */
  company?: string;
  query: string;
}

export interface SourceMixPlan {
  queries: ScoutQuery[];
  dropped: ScoutQuery[];
  watchlist_share: number;
}

/** Max watchlist queries allowed alongside `open` open-market queries so share <= max. */
export function maxWatchlist(open: number, shareMax: number): number {
  if (shareMax <= 0) return 0;
  if (shareMax >= 1) return Number.POSITIVE_INFINITY;
  // w / (w + open) <= s  =>  w <= s * open / (1 - s)
  return Math.floor((shareMax * open) / (1 - shareMax) + 1e-9);
}

/**
 * Keep every open query; keep watchlist queries in the given (priority) order up to the share cap,
 * at most one per company per run. A run with no open queries runs no watchlist queries.
 */
export function planSourceMix(proposed: readonly ScoutQuery[], shareMax: number): SourceMixPlan {
  const open = proposed.filter((q) => q.kind === 'open');
  const limit = maxWatchlist(open.length, shareMax);
  const seen = new Set<string>();
  const kept: ScoutQuery[] = [];
  const dropped: ScoutQuery[] = [];
  for (const q of proposed) {
    if (q.kind !== 'watchlist') continue;
    const key = q.company ?? q.query;
    if (kept.length < limit && !seen.has(key)) {
      kept.push(q);
      seen.add(key);
    } else dropped.push(q);
  }
  const queries = proposed.filter((q) => q.kind === 'open' || kept.includes(q));
  return { queries, dropped, watchlist_share: queries.length ? kept.length / queries.length : 0 };
}

/** Watchlist = Company component `data_json.watchlist` (slugs), else its affinity map's positive entries. */
export function watchlistFrom(companyComponentData: Record<string, unknown> | undefined): string[] {
  const d = companyComponentData ?? {};
  if (Array.isArray(d.watchlist)) return d.watchlist.map(String);
  const aff = d.affinity;
  if (aff && typeof aff === 'object') {
    return Object.entries(aff as Record<string, unknown>)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .map(([k]) => k);
  }
  return [];
}
