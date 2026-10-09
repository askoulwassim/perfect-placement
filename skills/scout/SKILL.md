---
name: scout
description: Find new roles that fit the user's profile and add them to the pipeline inbox. Runs the scout plan (plan.md), captures facts for every hit, and hands candidates to the `roles.add` op, which dedupes (url, ATS job id, company + fuzzy title) and writes the run log. Never scores, never moves roles.
---

# Scout

Surface fresh, on-target roles, ready to score. You supply **judgment only** (which postings are real and on-target, and their facts). The `roles.add` op does every mechanical step: dedupe against the whole pipeline (every status, including archived), id assignment, company creation, role markdown, `role_added` events and the coverage log in `runs/`. Do not check duplicates or write files yourself.

## When

Weekly scheduled run, on demand, or when the user hands you links (skip searching, go straight to step 4).

## Steps

1. `runs.start { skill: "scout" }`. Keep the returned `run.id`; pass it as the run context on every op below.
2. Read the profile: `profile.get` (Craft, Domain, Work mode, Terms, Company, Dealbreakers). Build queries from it, not from memory.
3. Run the **whole** query set in the scout plan (`plan.md`: source mix, watchlist share, boards) with web search, and open each hit with web fetch. For each hit capture the candidate fields below from the posting itself.
4. Early filter: drop only clear dealbreakers (Dealbreakers and Work mode components). Keep anything borderline; scoring decides.
5. Call `roles.add { candidates: [...] }` once per batch. Relay its `added` and `duplicates`; possible duplicates land in Needs you on their own.
6. `runs.finish { run_id, status: "ok", summary: { queries_run, added, duplicates }, note: "<queries and sources actually run>" }`.

CLI equivalent (does 1, 5 and 6): `pp scout --in candidates.json --note "<queries run>"`.

## Candidate fields (`roles.add`)

Required: `company_name`, `title`, `source` (`scout` | `link` | `watchlist` | `referral` | `manual`).
Optional, only when the posting states it: `url`, `ats_job_id`, `company_domain`, `posted_at` (ISO), `workplace` (`remote` | `hybrid` | `onsite` | `flexible` | `unspecified`), `location`, `comp_min`, `comp_max`, `comp_currency` (3 letters), `jd_markdown` (the full JD; capture it now if the page is open).

## Skill files

`plan.md` ships next to this file in the repo (`skills/scout/plan.md`), not in the vault. A headless run gets it inlined in its prompt; in a live session read it from the repo. Never look for it (or this file) with `vault.read`.

## Tools

The pp MCP tools plus web search and web fetch (a headless run pre-approves exactly these). If one is denied, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

## Rules

- Every write is an op. Never edit the db or the vault.
- Never fabricate postings, comp, dates or URLs. Record the source for every candidate.
- LinkedIn job pages: read only through the user's signed-in browser, slowly; never message or connect.
- Scout never scores. Hand off to the score skill next.
- Never submit an application or send an email.
