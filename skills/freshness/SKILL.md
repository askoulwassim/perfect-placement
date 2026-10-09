---
name: freshness
description: Keep unapplied roles honest. Daily, check every inbox, active, held, on-deck and draft-ready posting is still open via the roles.check_freshness op; when asked, judge from page text whether a posting still accepts applications. Never touches applied or later roles.
---

# freshness

**Owner: lane G.** Schedule: daily 06:30 (`config.schedules.freshness`).

## What you do

1. **Run the check.** Call the op, never the network or the db yourself:
   - Daily: `roles.check_freshness { all_in_scope: true }`
   - One role or a few (before research or tailor): `roles.check_freshness { role_ids: [...] }`
   - Preview without writes: same call with `dryRun` in the op context.
2. **Report the outcome** in one line: checked, open, closed, unsure, stale. Name closed and unsure roles. No narration.

## How the op decides (mechanics, not yours)

| Rung | Signal | Result |
| --- | --- | --- |
| ATS API (Greenhouse, Lever, Ashby) | posting returned | open, `last_checked_at` touched |
| ATS API | posting gone from a live board | closed evidence -> resolver |
| Page fetch | 404 / 410, redirect to listing, closed phrase, Ashby `posting:null` | closed evidence -> resolver |
| Page fetch | anything else, bot wall, timeout | page text -> resolver |
| Resolver Noulli "Is this posting still accepting applications?" | no + policy auto (p >= 0.92 for `freshness.closed`) | archived, reason `closed`, 24h undo |
| Resolver | routed to human, conflict with hard evidence, or backend down | `unsure`, waits in Needs you with the pick and p |
| Age (posted, else found) > `freshness.stale_after_days` (45) | | `stale` flag only, no move |
| Second check in a row that cannot confirm open (`flags_json.unverified_checks`) | bot wall, no ATS match, contradicted closed evidence, no URL | rule close `freshness.closed`, auto + undo (24h) |
| Second check in a row that cannot confirm open | page loads, nothing decisive | rule close waits in Needs you (p 0.75) |
| `precheck: true` (the pipeline, before scoring a scout's new inbox roles) | hard closed evidence | archived on a rule decision, no backend asked |

Out of scope, never read or written: applied, interviews, offers, archived. Applied and later belong to the inbox monitor.

## When you are the judge

The resolver may route the Noulli question to an LLM, or a human may ask you to look at an `unsure` role. The state you get: role, company, url, ats, `checked_via`, `signal`, `evidence`, `http_status`, `final_url`, `page_text`.

Answer **no** (not accepting) only on positive evidence the posting is gone:
- the page says so ("no longer accepting applications", "position has been filled", "job not found"),
- the ATS returned 404 for the job while the board answered,
- the URL bounced to a generic careers or listing page.

Answer **yes** when the page shows the JD with a live apply path. If the page is a bot wall, a login wall, empty, or unrelated, you do not know: give a low probability rather than guess. A wrong close loses a role; a wrong open costs one more check tomorrow.

## Tools

A headless run pre-approves exactly these (`SKILL_TOOLS` in `packages/engine/ops/runner.ts`; a test keeps this list and that one equal) and denies everything else. If one you need is denied or missing, do not work around it: `runs.finish { run_id, status: "error", summary: { error: "tool denied: <tool>", denied_tools: [...] } }`.

- `mcp__pp`: the pp MCP tools (every Perfect Placement read and write is an op).
- `WebSearch`: find the live posting when the stored URL is unclear.
- `WebFetch`: read the live posting page when you are the judge.

## Rules

- Supply judgment only; every write is an op (`roles.check_freshness`; humans accept or undo through `decisions.resolve` / `decisions.undo`).
- Never touch applied-or-later roles. Never archive a role yourself.
- Polite traffic: the op paces requests and calls each Ashby board once per run. Do not loop it.
- Never submit an application or send an email.
