# Scout plan

**Owner: lane F.** How the scout skill (lane B) spends its queries each run.

## Source mix

- **Watchlist** = the Company component (`company.watchlist`, else companies with positive `company.affinity`, highest first).
- Watchlist career-page queries are **at most `config.scout.watchlist_share_max`** (default 0.34) of a run's queries. At most one watchlist query per company per run. A run with no open-market queries runs no watchlist queries.
- The rest are **open-market** queries built from the profile, not from company names: Craft (function, level), Domain (ranked problem spaces), Work mode (remote, locations).
- Propose the full list, then pass it through `planSourceMix(proposed, config.scout.watchlist_share_max)` (`packages/engine/scoring/source-mix.ts`). Run only `queries`; log `dropped` and `watchlist_share` in the run summary.

## Why

Left alone, scouting concentrates the active list in a few loved companies. The per-company cap stops a company from taking more than its share of `active`; the source mix stops it from taking more than its share of the search.

## Rotation

- Rotate watchlist companies across runs so each gets a turn: order by last-queried date, oldest first, then affinity.
- After a profile change (Learn), rebuild open-market queries from the new Domain and Craft ranking.

## Never

- Never put company names into open-market queries to get around the cap.
- Never submit an application or send an email.
