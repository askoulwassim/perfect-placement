# Architecture

How Perfect Placement is put together: the layers, the flow a role moves through, the profile model, scoring, freshness, connect and the UI. Decisions referenced as `#N` are in [`decisions.md`](decisions.md) and [`wave1-decisions.md`](wave1-decisions.md); `(#NNN)` numbers are GitHub issues.

## Layers

| Layer | Pieces |
| --- | --- |
| Surfaces | Web UI (local), MCP server, `pp` CLI, schedules, AGENTS.md |
| Skills (judgment) | onboard, scout, score, freshness, research, tailor, connect, fill, inbox, interview (later), learn |
| Engine (mechanics) | ops registry, status machine, scoring math, dedupe, profile versions, doctor |
| Decisions | resolver: `ask()` with rule / Kev / agent / LLM / human backends + policy |
| Vault (local) | `pp.db`, markdown vault, files |
| Integrations | Gmail (read + draft only), ATS APIs (Greenhouse, Lever, Ashby), LinkedIn (browser, read-only), web search, calendar (later) |

Every surface calls ops. Skills are SKILL.md files: they supply judgment (search hits, 1-5 scores, classifications, drafted text) and call ops for every write.

## Flow

| # | Stage | When | Output |
| --- | --- | --- | --- |
| 00 | Onboard | once, then per component | profile v1 |
| 01 | Scout | weekly | inbox |
| 02 | Score | after scout | active, held, or archived |
| 03 | Freshness | daily | open / closed / unsure per unapplied role |
| 04 | Research | on pick | company dossier |
| 05 | Tailor | on pick | resume, cover, fit map -> draft-ready |
| 06 | Connect | on pick | contacts + Gmail drafts |
| 07 | Fill | on pick | answers to the real portal questions |
| 08 | Submit | you, always | applied (via confirmation email) |
| 09 | Inbox | daily | interviews, offers, archived; outreach replies |
| 10 | Interview | scheduled | prep, retro |
| 11 | Learn | continuous | profile diffs -> rescore |

Statuses (in order): `inbox`, `active`, `held`, `on-deck`, `draft-ready`, `applied`, `interviews`, `offers`, `archived`. `held` = over the per-company cap. `on-deck` = picked (UI label **In progress**, #105): starting an apply stage (Research, Tailor or Connect, the op or `runs.start`, human or agent) on an active or held role moves it there and emits `role_picked`; Tailor then moves it to `draft-ready`. On-deck takes no company slot and a rescore never moves it. `archived` always has a reason: `below_threshold`, `dealbreaker`, `closed`, `rejected`, `passed`, `withdrawn`. No-downgrade rule: an automated rescore never moves a role backwards out of `draft-ready` or later.

Learning signals: role picked or skipped from active, closed while waiting, rejected (and at which stage), interview retro, outreach replied or ignored, offer terms.

## Profile: 11 components

Each component is versioned, has a confidence (0 to 1), and a kind.

| Component | Kind | Holds | First captured | Learns from |
| --- | --- | --- | --- | --- |
| Story | asset | resume facts, wins, metrics | resume parse | stories that landed in interviews |
| Craft | weighted | function and level (PM, TPM, FDE; IC or lead) | resume + questions | callback rate by level and function |
| Domain | weighted | problem spaces, ranked | interview + calibration | picks vs skips |
| Work mode | filter | remote / hybrid / onsite, locations, travel | interview | exceptions approved |
| Terms | filter | comp floor and target, equity appetite | interview | offers, roles skipped for comp |
| Company | weighted | stage, size, mission, affinity list (capped) | interview + calibration | freshness, rejections, skips |
| Team | weighted | proximity to decisions, leaders, reporting line | calibration | interview retros |
| Growth | weighted | scope ceiling, trajectory | interview | offers, retros |
| Dealbreakers | filter | hard nos | interview | only by explicit edit |
| Voice | asset | writing style, positioning, standard answers | writing samples | edits to drafts |
| Network | asset | people and companies where warm | LinkedIn | outreach replies |

Filters gate (pass/fail). Weighted components produce the rubric weights. Assets feed writing and outreach.

## Onboarding protocol

1. **Resume in.** Parse into Story and Craft drafts. Never ask what the resume answers.
2. **Interview by component.** Two to four adaptive questions per gap, chips or sliders over free text. Any single component can be re-interviewed later without redoing the rest.
3. **Calibrate.** Yes / no / maybe on 12 real sample postings. Derive criterion weights from choices (stated preferences are a prior, choices win).
4. **Confirm.** Profile card. Profile v1 saved.

## Learn loop

event -> resolver asks per component "does this change it?" (Noulli x 11) -> for each yes, LLM drafts a diff with evidence -> policy decides auto / undo / human (weights: low or medium impact; filters and dealbreakers: high) -> profile v+1 -> rescore affected active roles -> scout plan adjusts.

## Scoring v2

- **Blind role scoring**: company name masked for role criteria (C1 decisions, C2 0-to-1, C3 external, C4 data, C9 shape).
- **Company affinity** is a separate modifier, capped at +/-5 points.
- **No dealbreaker bypass** for dream companies.
- **Per-company cap**: top 3 per company stay `active`; the rest go to `held` (promoted automatically when a slot frees).
- **Source mix**: watchlist career pages at most a third of scout queries and of the roles a run adds (`ceil(share x target)`), at most `scout.max_per_company` per company per run; open-market search always runs for the rest (#67). Watchlist comes from the Company component.
- Weights come from the profile version; every score records the rubric/profile version.
- Criteria (unchanged ids): C1 proximity to decisions, C2 0->1 scope, C3 external-facing, C4 data fundamentals, C5 domain excitement, C6 comp and equity, C7 team and leaders, C8 growth ceiling, C9 role shape. Green >= 75, yellow >= 55.

## Freshness (daily)

- Scope: `active`, `held`, `on-deck`, `draft-ready`. Applied and later belong to the inbox monitor.
- Ladder: ATS public API (Greenhouse `boards-api.greenhouse.io/v1/boards/{board}/jobs/{id}`, Lever `api.lever.co/v0/postings/{company}/{id}`, Ashby `api.ashbyhq.com/posting-api/job-board/{name}`) -> page fetch (404, redirect to listing, "no longer accepting") -> resolver Noulli "still accepting applications?".
- Outcomes: open (touch `last_checked`), closed (archive, reason `closed`, medium impact), unsure (human), age > 45 days (flag only).
- First run backfills every unapplied role.

## Connect

Tiers and default drafts:

| | Hiring team | Not hiring team |
| --- | --- | --- |
| **Warm (1st degree)** | Ask for a conversation about the role | Coffee chat, or intro to the hiring manager |
| **Bridge (2nd degree)** | Note to the mutual + forwardable blurb | same |
| **Cold** | Positioning note: their problem, one proof, one ask | Skip unless asked |

A 2nd-degree hiring-team target has two paths (#98): a **direct** note to them, or a **bridge** intro through the mutual. Code ranks them: direct when the target's email is confirmed or likely and the mutual is a weak tie (other company, no history); bridge only for a strong mutual (same company as the target, or history) with an email. Never a draft to a mutual with no email while a direct path exists. People shows both with one-line reasons; the user can switch, and may draft both: each draft is filed under the person it is addressed to (a bridge intro under the mutual, about the target).

Sources: LinkedIn (browser automation, read-only: connections, company People page, mutuals), Gmail contacts, the JD and company team page. Output: contacts + `contact_role` links + Gmail **drafts** (never send). Replies come back through the inbox monitor as `outreach_replied` events.

## UI

Source of truth: the Claude Design prototype ([`design.md`](design.md)). Screens: Now, Needs you, River, Role, People, Outreach draft, You, Onboarding, Ask (Cmd+K), Settings. Principles: visual over verbal, one primary action per screen, state is color and shape, only "needs you" interrupts, every button is an op, agent replies render as the same cards.

## OpenUI

Thesys OpenUI (MIT, React, Zod-typed component props, streamed "OpenUI Lang") renders agent replies in the Ask panel as our own components (RoleCard, ScoreRadar, ContactCard, ProfileDiff). Adapted, not adopted wholesale: `wave1-decisions #21`, `apps/web/genui/`.
