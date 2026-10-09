# Scout plan

**Owner: lane F.** How the scout skill (lane B) spends its queries each run.

## Sources

1. **Watchlist boards (ATS API).** `scout.watchlist_scan` lists every open role on each watchlist company's Greenhouse, Lever or Ashby board and drops clear title, seniority and work-mode misses plus roles already in the pipeline. It then ranks each company's survivors by title and profile fit (Craft function and level, Domain rank), groups near-identical titles (same company, title similarity >= 0.85: one candidate stands for the group) and returns at most **`config.scout.max_per_company`** per company (default `scoring.company_active_cap` + 2 = 5), reporting `capped` and `grouped` per company. Every watchlist company is scanned every run. Board scans are API reads, not search queries: they do not count toward the query share cap or `max_queries`.
2. **Watchlist web search.** Only for watchlist companies the scan reports `no_board` or `error` (Workday, custom career sites). One query per company per run, under the share cap below.
3. **Open market (web search).** Queries built from the profile, not from company names: Craft (function, level), Domain (ranked problem spaces), Work mode (remote, locations).

## Share cap (watchlist adds, #67)

- A run adds at most **`ceil(watchlist_share_max x target_new_roles)`** watchlist roles (source `watchlist`, boards and watchlist web queries together; 9 of 25 by default) and at most `max_per_company` per company. `roles.add` enforces both per scout run (`skipped` reason `watchlist_cap` / `company_cap`) and returns `watchlist_budget`, so a board with 700 roles cannot fill the run.
- Open-market search **always runs** and fills the rest: keep going while `watchlist_budget.open_needed` > 0 (and the query budget lasts), even when the board scan alone found more than the target.
- `runs.finish` records the achieved mix vs the target (`summary.source_mix`, one "Source mix" line in the run log).

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

Left alone, scouting concentrates the active list in a few loved companies (a first run added 38 roles, 30 from one company, and ran no open-market query). The per-company cap stops a company from taking more than its share of `active`; the share caps stop the watchlist from taking more than its share of the search and of the adds. ATS board scans read a company's whole list cheaply and completely, so they replace watchlist searches where a board exists, inside the same share.

## Scoring cost

Every added role costs one score. The intake limits bound it: at most `max_per_company` roles per company per run, so at most `max_per_company - company_active_cap` (2 by default) of a company's new roles can end `held`, and near-identical titles are grouped before they are added. The score run does not skip roles the cap might hold: whether a role stays `active` or goes `held` (or is archived below threshold) depends on its own total against the company's current active roles, which is unknown until it is scored.

## Rotation

- Rotate watchlist web queries across runs so each company without a board gets a turn: order by last-queried date, oldest first, then affinity.
- After a profile change (Learn), rebuild open-market queries from the new Domain and Craft ranking.

## Never

- Never put company names into open-market queries to get around the cap.
- Never submit an application or send an email.
