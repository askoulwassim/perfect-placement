# Decisions

The founding decisions behind Perfect Placement. Code and docs cite them as `decisions.md #N`; the decisions made while building the first version are in [`wave1-decisions.md`](wave1-decisions.md) and cited as `wave1-decisions #N`. Changes are logged at the bottom with a date and reason.

| # | Topic | Decision | Notes |
| --- | --- | --- | --- |
| 1 | Runtime | **TypeScript monorepo**: engine, resolver, MCP, CLI, web in one language | OpenUI and the MCP SDK are TS-native. |
| 2 | Data home | **`~/.perfect-placement`** (hidden). `PP_HOME` overrides. | Stays openable as an Obsidian vault. |
| 3 | Source of truth | **SQLite for structure, markdown for long-form, linked by id** | Markdown frontmatter carries the DB id. |
| 4 | Autonomy | **Confidence x impact policy** (below) for every decision | Replaced by the grid in `wave1-decisions #24`. |
| 5 | Dream companies | **Capped nudge (+/-5 points), no dealbreaker bypass** | Plus blind role scoring and a per-company cap. |
| 6 | 2nd-degree discovery | **Browser automation on LinkedIn** in the user's own signed-in session | Read-only, slow, capped per day, only on picked roles. LinkedIn's terms restrict automation: keep volume low, never message from automation. |
| 7 | Decision models | **Kev**, a local open-weights System One model | See Decision backends. |
| 8 | Agent instructions | **AGENTS.md only. No CLAUDE.md anywhere.** | See AGENTS.md verification. |
| 9 | Scheduled runs | Schedules are OS jobs installed by `pp schedules` | |
| 10 | OpenUI | **Adopted for Ask replies** (parser + streaming renderer, our own components) | `wave1-decisions #21`. |
| 11 | UI design | **The Claude Design prototype is the UI source of truth** | Its tokens and inventory are in [`design.md`](design.md). |
| 12 | Repo | **One repo for the system; personal data lives only in the vault** | Enforced by `.gitignore` and `scripts/check-repo.mjs`. |
| 13 | Codex Gmail | **Fail closed until exact raw-tool isolation is verified** | 2026-10-17; [#158](https://github.com/askoulwassim/perfect-placement/issues/158). See below. |

## Decision policy (confidence x impact)

Every decision a human would otherwise make goes through the resolver first. The human always sees the pick and its probability, never a blank question. The grid (`wave1-decisions #24`, `POLICY_GRID` in contracts):

| Impact \ p | >= auto | second_opinion to auto | < second_opinion |
| --- | --- | --- | --- |
| Low | auto | auto | auto + undo |
| Medium | auto | auto if a second backend agrees | human |
| High | auto + undo | human | human |

- **Hard exclusions**, always human and not tunable: submit an application, send an email, delete anything, change a dealbreaker, change the comp floor.
- "Second backend agrees" = the calling agent session (or the LLM adapter, when enabled) confirms the pick: same option, its p >= 0.70.
- "Auto + undo" = applied now, shown on Now for 24h with one-tap undo.
- Thresholds live in `config.json`, with per-kind overrides. Human overrides are logged and used to retune them.

## Decision backends

- **Kev** ([jaredpalmer/kev](https://github.com/jaredpalmer/kev), Apache-2.0, Qwen-based; Hugging Face `jaredpalmer/kev-0.8b`, `kev-4b`, `kev-9b`, `kev-27b`). Serves `POST /v1/systemone`: a state plus typed questions (choice, yes/no "Noulli", score) in, answers with probabilities and confidence out. It returns no reasons, is weak on numbers and dates (those stay rule-based), and always picks an option (always include an "other"). Setup: `packages/resolver/docs/kev-setup.md`.
- The **calling agent session** (Claude Code, Codex, Cursor) answers over MCP and gives second opinions.
- Writing (resume, letters, answers, emails, profile diff text) always comes from an LLM in the agent session, never from a System One model.

## AGENTS.md verification

Claude Code reads `AGENTS.md` only when **no** `CLAUDE.md` exists in the working directory or any parent directory. Gotchas:

- Any `CLAUDE.md` above the repo silently disables the fallback. `pp doctor` checks the parent chain.
- Nested `AGENTS.md` files only load if no `CLAUDE.md` exists above them.

## Change log

- 2026-10-08: initial decisions.
- 2026-10-08: #7 set to Kev only. LLM work runs in the user's agent session over MCP, with no API key; UI buttons and schedules start headless agent runs. #6 refined: LinkedIn people-reads on by default (read-only, capped). `wave1-decisions #7`, `#9`.
- 2026-10-08: #4 replaced by the prototype's grid with hard exclusions. `wave1-decisions #24`.
- 2026-10-08: fresh start. No v1 data is imported; the v1 migration code was removed and migration 003 drops the migration-only enum values. `wave1-decisions #26`.
- 2026-10-09: first-run guidance is a one-time Getting started card on Now. `wave1-decisions #27`.
- 2026-10-10: open-source preparation. #9, #10 and #12 updated to their current state; the hosted decision backend that was disabled by default was removed.

## 13. Codex Gmail isolation (2026-10-17)

[#158](https://github.com/askoulwassim/perfect-placement/issues/158): only the canonical OpenAI Gmail plugin is eligible. Codex 0.163.0's app policy admits title aliases and ignores the ordinary MCP allowlist on its built-in app server; a synthetic headless runtime probe demonstrated execution of an unlisted tool. Keep all Gmail modes blocked before launch, record `setup required: Gmail` through `runs.finish`, and never retry setup failures. Non-Gmail runs and Ask disable apps and alternate routes in child processes. Never change persistent settings or weaken managed requirements. [Evidence, grants, identity, precedence and sparse-update contract](codex-gmail-isolation.md). No public contract change.
