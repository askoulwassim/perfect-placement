---
name: scout
description: Find new roles that fit the user's profile and add them to the pipeline inbox. Scans every watchlist company's ATS board (`scout.watchlist_scan`), runs the scout plan's web queries (plan.md) until the run reaches its target, and hands candidates to the `roles.add` op, which dedupes, skips dead postings, swaps aggregator links for the company's own posting and writes the run log. Never scores, never moves roles.
---

# Scout

Surface fresh, on-target roles, ready to score. You supply **judgment only** (which postings are real and on-target, and their facts). Ops do every mechanical step: `scout.watchlist_scan` lists and rule-filters whole ATS boards; `roles.add` dedupes against the whole pipeline (every status, including archived), checks each posting URL (dead postings skipped, aggregator links resolved to the company's ATS posting or skipped, bot walls kept as `unsure`), captures the full JD from the ATS, assigns ids, creates companies, writes role markdown, `role_added` events and the coverage log in `runs/`. Do not check duplicates, liveness or files yourself.

## When

Weekly scheduled run, on demand, or when the user hands you links (skip searching, go straight to step 6).

## Steps

1. `runs.start { skill: "scout" }`. Keep the returned `run.id`; pass it as the run context on every op below.
2. Read the profile (`profile.get`: Craft, Domain, Work mode, Terms, Company, Dealbreakers) and the targets (`config.get`: `scout.target_new_roles`, `scout.max_queries`, `scout.watchlist_share_max`). Build queries from the profile, not from memory.
3. **Watchlist boards:** `scout.watchlist_scan {}` (all watchlist companies; pass `include` title keywords if the Craft functions are too narrow or too broad). Drop clear dealbreakers from its `candidates`, then `roles.add` the rest. Companies that come back `no_board` or `error` get one watchlist web query each, under the share cap (plan.md).
4. **Open market:** run the plan's open-market queries with web search, several result pages each, and open each hit with web fetch to capture the candidate fields below. After each batch, `roles.add { candidates }` and add its `added` to the run total.
5. **Keep going until the target:** while the run total is below `target_new_roles` and fewer than `max_queries` web searches ran, build the next query variation (plan.md "Yield") and repeat step 4. Stop early when two variations in a row add nothing new.
6. Early filter, every batch: drop only clear dealbreakers (Dealbreakers and Work mode components). Keep anything borderline; scoring decides. Prefer the company's own posting URL when the page links to it; otherwise pass what you found (`roles.add` resolves or skips aggregator links).
7. `runs.finish { run_id, status: "ok", summary: { target, queries_run, added, duplicates, skipped_dead, skipped_aggregator, sources: { watchlist_ats: {...}, watchlist_search: {...}, open_market: {...} } }, note: "<queries and sources actually run>" }`. Each source entry is `{ queries, hits, duplicates, skipped_dead, skipped_aggregator, added }`: `queries` and `hits` are yours (board scans count as 0 queries, hits = scan candidates), the rest is the sum of that source's `roles.add` outputs (`by_source`, or `added` / `duplicates` / `skipped` per call).

CLI equivalent for links (runs.start, one roles.add, runs.finish): `pp scout --in candidates.json --note "<queries run>"`.

## Candidate fields (`roles.add`)

Required: `company_name`, `title`, `source` (`scout` | `link` | `watchlist` | `referral` | `manual`).
Optional, only when the posting states it: `url`, `ats_job_id`, `company_domain`, `posted_at` (ISO), `workplace` (`remote` | `hybrid` | `onsite` | `flexible` | `unspecified`), `location`, `comp_min`, `comp_max`, `comp_currency` (3 letters), `jd_markdown` (a short summary is fine; the ATS JD replaces it when the posting is on Greenhouse, Lever or Ashby).

`roles.add` output: `added`, `duplicates`, `possible_duplicates`, `skipped` (`dead` | `aggregator`, with the reason), `resolved` (aggregator link -> company posting), `by_source` counts.

## Skill files

`plan.md` ships next to this file in the repo (`skills/scout/plan.md`), not in the vault. A headless run gets it inlined in its prompt; in a live session read it from the repo. Never look for it (or this file) with `vault.read`.

## Tools

The pp MCP tools plus web search and web fetch (a headless run pre-approves exactly these). If one is denied, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

## Rules

- Every write is an op. Never edit the db or the vault.
- Never fabricate postings, comp, dates or URLs. Record the source for every candidate.
- LinkedIn job pages: read only through the user's signed-in browser, slowly; never message or connect. Never store a LinkedIn or other aggregator URL as the posting: `roles.add` resolves it or skips it.
- Scout never scores. Hand off to the score skill next.
- Never submit an application or send an email.
