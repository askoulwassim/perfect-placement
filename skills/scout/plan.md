# Scout plan

**Owner: lane F.** How the scout skill (lane B) spends its queries each run.

## Sources

1. **Watchlist boards (ATS API).** `scout.watchlist_scan` lists every open role on each watchlist company's Greenhouse, Lever or Ashby board and drops clear title, seniority and work-mode misses plus roles already in the pipeline. Every watchlist company is scanned every run. Board scans are API reads, not search queries: they do not count toward the share cap or `max_queries`, and the number of roles they find is not capped (the per-company active cap still applies at scoring).
2. **Watchlist web search.** Only for watchlist companies the scan reports `no_board` or `error` (Workday, custom career sites). One query per company per run, under the share cap below.
3. **Open market (web search).** Queries built from the profile, not from company names: Craft (function, level), Domain (ranked problem spaces), Work mode (remote, locations).

## Share cap (watchlist web queries)

- Watchlist = the Company component (`company.watchlist`, else companies with positive `company.affinity`, highest first).
- Watchlist web queries are **at most `config.scout.watchlist_share_max`** (default 0.34) of the run's web queries. A run with no open-market queries runs no watchlist web queries.
- Propose the full list, then trim it (the rule `planSourceMix` in `packages/engine/scoring/source-mix.ts` implements; you have no access to it in a run): keep every open-market query; keep watchlist queries in priority order, one per company, up to `floor(share * open / (1 - share))` where `share` = `config.scout.watchlist_share_max` (`config.get`). Example: share 0.34 and 6 open queries allow 3 watchlist queries. Recompute as open-market variations are added. Log `dropped` and `watchlist_share` in the run summary.

## Yield

- A run aims for **`config.scout.target_new_roles`** (default 25) roles added, using at most **`config.scout.max_queries`** (default 30) web searches.
- Start with the strongest combinations, then widen. Variations are the cross product, in this order:
  1. titles: each Craft function at the profile level, then its synonyms and one level up or down ("Principal Product Manager", "Director of Product", "Group PM", "Head of Product");
  2. domains: each ranked Domain, highest first ("data platform", "AI infrastructure");
  3. seniority words: `principal`, `staff`, `director`, `head of`, per Craft level;
  4. work mode: `remote` plus each Work mode location;
  5. boards and sites: Greenhouse (`site:job-boards.greenhouse.io`, `site:boards.greenhouse.io`), Lever (`site:jobs.lever.co`), Ashby (`site:jobs.ashbyhq.com`), then general web results.
- Read several result pages per query (page 2 and 3) before moving to the next variation.
- Stop when the target is met, the query budget is spent, or two variations in a row add nothing new (duplicates, dead or off-target only).

## Why

Left alone, scouting concentrates the active list in a few loved companies. The per-company cap stops a company from taking more than its share of `active`; the share cap stops it from taking more than its share of the search. ATS board scans read a company's whole list cheaply and completely, so they replace watchlist searches where a board exists.

## Rotation

- Rotate watchlist web queries across runs so each company without a board gets a turn: order by last-queried date, oldest first, then affinity.
- After a profile change (Learn), rebuild open-market queries from the new Domain and Craft ranking.

## Never

- Never put company names into open-market queries to get around the cap.
- Never submit an application or send an email.
