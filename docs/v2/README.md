# Perfect Placement v2: build handoff

This folder is the complete brief for building Perfect Placement v2. It was written in a planning session on 2026-10-08 and is meant to be read by coding agents (Claude Code, Codex, Cursor) with no other context.

**Start here:** paste `KICKOFF.md` into a fresh Claude Code session opened at this repo.

## What v2 is

Perfect Placement becomes a **distributable system** instead of a personal folder. The repo holds only the system (engine, skills, MCP server, web UI, decision layer). Each person's data lives in a local vault at `~/.perfect-placement` (SQLite + markdown), never committed. The UI, the MCP server, the CLI and scheduled runs all call **one ops registry**, so anything a human can click, an agent can do.

## Read in this order

| File | What it is |
| --- | --- |
| `KICKOFF.md` | The prompt for the first Claude Code session. Runs Wave 0. |
| `decisions.md` | Every locked decision. Do not relitigate these without asking Wassim. |
| `blueprint.md` | The system: architecture, flow, profile model, skills, decision layer, UI. |
| `contracts.md` | Wave 0 spec: repo layout, schema, ops, events, resolver interface, policy. |
| `design.md` | The Claude Design prototype (source of truth for the UI) and how to import it. |
| `claude-design-prompt.md` | The brief the prototype was built from. |
| `lanes/` | One brief per Wave 1 lane (A to J) plus Wave 2 integration. |
| `v1-inventory.md` | What exists today in this repo and where it maps in v2. |

## Waves

- **Wave 0** (one agent, sequential, blocks everything): contracts.
- **Wave 1** (ten agents in parallel, one git worktree each): lanes A to J.
- **Wave 2** (one agent): integrate, cut over schedules, one real role end to end.
- **Wave 3** (later): interviews skill, open-source packaging, multiple profiles.

## Ground rules for every agent

1. Read `decisions.md` first. Locked means locked.
2. Personal data never enters the system repo. Nothing from `01_Profile/`, `02_Pipeline/`, `03_Applications/`, `04_Interviews/`, the resume PDF, or any `.docx` gets committed there. Fixtures are synthetic.
3. A lane only writes inside the folders it owns (see its brief). Contract changes go through `CONTRACT_CHANGES.md`, not direct edits.
4. Model supplies judgment, code supplies mechanics. No skill hand-edits data; every write is an op.
5. Never submit an application or send an email. Gmail access is draft-only.
6. Writing style for anything user-facing in Wassim's name: no em dashes; punchy (hook, reframe, close).
7. UI copy: no explanatory text, no tips, labels of one to three words. See `design.md`.

Interactive blueprint (private, for Wassim): https://claude.ai/artifact/DXXe7XXPkocYk4oGNXk8e8
