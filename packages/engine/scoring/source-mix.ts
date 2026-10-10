/*
 * Scout source mix (docs/architecture.md "Scoring v2"): watchlist career pages are at most
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

/** What a scout run added, by source, against its targets (#67): shown in the run summary and log. */
export interface AchievedMix {
  target: number;
  added: number;
  watchlist: number;
  open: number;
  /** ceil(watchlist_share_max * target): the most watchlist adds a run keeps. */
  watchlist_max: number;
  watchlist_share: number;
  watchlist_share_max: number;
  by_source: Record<string, number>;
  /** Watchlist roles per company. */
  by_company: Record<string, number>;
}

export function achievedMix(
  adds: ReadonlyArray<{ source: string; company_id: string }>,
  scout: { target_new_roles: number; watchlist_share_max: number },
): AchievedMix {
  const by_source: Record<string, number> = {};
  const by_company: Record<string, number> = {};
  for (const a of adds) {
    by_source[a.source] = (by_source[a.source] ?? 0) + 1;
    if (a.source === 'watchlist') by_company[a.company_id] = (by_company[a.company_id] ?? 0) + 1;
  }
  const watchlist = by_source.watchlist ?? 0;
  return {
    target: scout.target_new_roles,
    added: adds.length,
    watchlist,
    open: adds.length - watchlist,
    watchlist_max: Math.ceil(scout.watchlist_share_max * scout.target_new_roles - 1e-9),
    watchlist_share: adds.length ? Math.round((watchlist / adds.length) * 100) / 100 : 0,
    watchlist_share_max: scout.watchlist_share_max,
    by_source,
    by_company,
  };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** One line for the run log: "Source mix: 25 added of 25 target; watchlist 9 (36%, max 9), open market 16". */
export function mixLine(m: AchievedMix): string {
  const companies = Object.entries(m.by_company)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c, n]) => `${c} ${n}`)
    .join(', ');
  return `Source mix: ${m.added} added of ${m.target} target; watchlist ${m.watchlist} (${pct(m.watchlist_share)}, target at most ${m.watchlist_max} / ${pct(m.watchlist_share_max)})${companies ? ` [${companies}]` : ''}, open market ${m.open}`;
}
