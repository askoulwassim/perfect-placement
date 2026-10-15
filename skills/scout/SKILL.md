---
name: scout
description: Find new roles that fit the user's profile and add them to the pipeline inbox. Scans every watchlist company's ATS board (`scout.watchlist_scan`, a capped share of the run), always runs the scout plan's open-market web queries (plan.md) until the run reaches its target, and hands candidates to the `roles.add` op, which dedupes, skips dead postings, swaps aggregator links for the company's own posting, enforces the watchlist share and writes the run log. Never scores, never moves roles.
---

# Scout

Surface fresh, on-target roles, ready to score. You supply **judgment only** (which postings are real and on-target, and their facts). Ops do every mechanical step: `scout.watchlist_scan` lists and rule-filters whole ATS boards; `roles.add` dedupes against the whole pipeline (every status, including archived), checks each posting URL (dead postings skipped, aggregator links resolved to the company's ATS posting or skipped, bot walls kept as `unsure`), captures the full JD from the ATS, assigns ids, creates companies, writes role markdown, `role_added` events and the coverage log in `runs/`. Do not check duplicates, liveness or files yourself.

## When

Weekly scheduled run, on demand, or when the user hands you links (skip searching, go straight to step 6).

## Steps

1. `runs.start { skill: "scout" }`. Keep the returned `run.id`; pass it as the run context on every op below.
2. Read the profile (`profile.get`: Craft, Domain, Work mode, Terms, Company, Dealbreakers), the query ingredients (`scout.plan {}`: `titles`, the persona-aware title variations from Craft `titles`, functions and level, plus `domains` and `locations`; a salesperson's are sales titles, never product ones) and the targets (`config.get`: `scout.target_new_roles`, `scout.max_queries`, `scout.watchlist_share_max`, `scout.max_per_company`). Build queries from the profile, not from memory.
3. **Watchlist boards (a capped share, never the whole run):** `scout.watchlist_scan {}` (all watchlist companies; pass `include` title keywords if the Craft functions are too narrow or too broad). It returns at most `max_per_company` candidates per company, best fit first, companies interleaved, near-identical titles grouped. Drop clear dealbreakers, then `roles.add` the rest **in the order given**. `roles.add` keeps at most `ceil(watchlist_share_max x target_new_roles)` watchlist roles per run (9 of 25 by default) and `max_per_company` per company; the rest come back `skipped` (`watchlist_cap` / `company_cap`). That is expected: do not resend them, relabel their `source`, or search for them on the open market. Companies that come back `no_board` or `error` get one watchlist web query each, under the query share cap (plan.md).
4. **Open market (always runs):** run the plan's open-market queries with web search, several result pages each, and open each hit with web fetch to capture the candidate fields below (`source: "scout"`). After each batch, `roles.add { candidates }`. Every `roles.add` answer carries `watchlist_budget`: `open_needed` is how many open-market roles the run still needs.
5. **Keep going until the target:** while `open_needed` is above 0 and fewer than `max_queries` web searches ran, build the next query variation (plan.md "Yield") and repeat step 4. This holds even when the board scan alone found more than `target_new_roles`: board roles fill at most the watchlist share. Stop early only when two variations in a row add nothing new.
6. Early filter, every batch: drop only clear dealbreakers (Dealbreakers and Work mode components). Keep anything borderline; scoring decides. Prefer the company's own posting URL when the page links to it; otherwise pass what you found (`roles.add` resolves or skips aggregator links).
7. `runs.finish { run_id, status: "ok", summary: { target, queries_run, added, duplicates, skipped_dead, skipped_aggregator, skipped_cap, sources: { watchlist_ats: {...}, watchlist_search: {...}, open_market: {...} } }, note: "<queries and sources actually run>" }`. Each source entry is `{ queries, hits, duplicates, skipped_dead, skipped_aggregator, skipped_cap, added }`: `queries` and `hits` are yours (board scans count as 0 queries, hits = scan candidates), the rest is the sum of that source's `roles.add` outputs (`by_source`, or `added` / `duplicates` / `skipped` per call). `runs.finish` adds the achieved source mix vs the target itself (`summary.source_mix`, one line in the run log); do not compute it.

CLI equivalent for links (runs.start, one roles.add, runs.finish): `pp scout --in candidates.json --note "<queries run>"`.

## Candidate fields (`roles.add`)

Required: `company_name`, `title`, `source` (`scout` | `link` | `watchlist` | `referral` | `manual`).
Optional, only when the posting states it: `url`, `ats_job_id`, `company_domain`, `posted_at` (ISO), `workplace` (`remote` | `hybrid` | `onsite` | `flexible` | `unspecified`), `location`, `comp_min`, `comp_max`, `comp_currency` (3 letters), `jd_markdown` (a short summary is fine; the ATS JD replaces it when the posting is on Greenhouse, Lever or Ashby).

`roles.add` output: `added`, `duplicates`, `possible_duplicates`, `skipped` (`dead` | `aggregator` | `watchlist_cap` | `company_cap`, with the reason), `resolved` (aggregator link -> company posting), `by_source` counts, `watchlist_budget` (`max`, `added`, `remaining`, `max_per_company`, `open_added`, `open_needed`).

## Skill files

`plan.md` ships next to this file in the repo (`skills/scout/plan.md`), not in the vault. A headless run gets it inlined in its prompt; in a live session read it from the repo. Never look for it (or this file) with `vault.read`.

## Tools

A headless run pre-approves exactly these (`SKILL_TOOLS` in `packages/engine/runners/grants.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

- `mcp__pp`: the pp MCP tools (every Perfect Placement read and write is an op).
- `WebSearch`: run the plan's queries on job boards and the open market.
- `WebFetch`: open each hit to capture the candidate fields.

## Rules

- Every write is an op. Never edit the db or the vault.
- Never fabricate postings, comp, dates or URLs. Record the source for every candidate.
- LinkedIn job pages: read only through the user's signed-in browser, slowly; never message or connect. Never store a LinkedIn or other aggregator URL as the posting: `roles.add` resolves it or skips it.
- Scout never scores. Hand off to the score skill next.
- The watchlist is at most its share of a run's adds. Never label a board or watchlist role `scout` to get past the cap.
- Never submit an application or send an email.
