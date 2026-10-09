# Perfect Placement: operating manual for agents

This is the only agent instruction file in this repo. **There is no CLAUDE.md anywhere, and there must never be one** (decisions.md #8): Claude Code reads AGENTS.md only when no CLAUDE.md exists in the working directory or any parent. `pp doctor` checks the parent chain.

## What this is

A local job-search system. It scouts roles, scores them against a learned profile, keeps the pipeline fresh, tailors applications, finds people who can open doors, watches the inbox, and learns from outcomes. The repo holds **only the system**. Each user's data lives in a local vault at `PP_HOME` (default `~/.perfect-placement`): SQLite (`pp.db`) for structure, markdown for long-form, linked by id. The web UI, the MCP server, the `pp` CLI and scheduled runs all call **one ops registry**, so anything a human can click, an agent can do.

Full brief: `docs/v2/` (start with `README.md`, then `decisions.md`; locked means locked).

## Layout

```
AGENTS.md               this file
CONTRACT_CHANGES.md     contract change requests and their resolutions
packages/
  contracts/            zod schemas, statuses, events, ops registry, resolver + policy types, design tokens, UI inventory
  engine/               openEngine(): db/ (repos, migrations, vault, doctor)  ops/ (runOp + handlers)  status/  profile/  scoring/  freshness/  people/  integrations/
  resolver/             decision layer: rule, Kev, agent, human; policy; decision ops
  mcp/                  MCP server generated from ops (stdio `pp-mcp`, HTTP at /mcp)
  cli/                  `pp`: setup, up, init, kev, doctor, op, scout, score, fresh, inbox
  fixtures/             synthetic vault + db seed (Wave 0)
apps/web/               UI from the Claude Design prototype; genui/ renders Ask replies with OpenUI
skills/<name>/SKILL.md  agent-agnostic skills
docs/v2/                the build brief
```

## Rules

1. **Every write is an op.** Nothing edits `pp.db` or the vault except op handlers called through `runOp(name, input, ctx)`. Skills, UI, MCP and CLI never write directly.
2. **Model supplies judgment, code supplies mechanics.** Skills produce search hits, 1 to 5 scores, classifications and drafted text, then call ops. Totals, bands, dedupe, status moves, counts, run logs and validation are code.
3. **Decisions go through the resolver.** A human never sees a blank question: they see the pick and its probability. Order: rule -> Kev (local System One model) -> the calling agent session -> human. No API key is used: LLM work happens in the agent session (Claude Code, Codex or Cursor) over MCP. Policy (confidence x impact, thresholds in `config.json`, `POLICY_GRID` in contracts):

   | Impact \ p | >= 0.90 | 0.70 to 0.90 | < 0.70 |
   | --- | --- | --- | --- |
   | Low | auto | auto | auto + undo |
   | Medium | auto | auto if a second opinion agrees | human |
   | High | auto + undo | human | human |

   **Hard exclusions, always human, not tunable** (`isHardHuman`): submit an application, send an email, delete anything, change a dealbreaker, change the comp floor. Per-kind overrides in `config.overrides` can tighten thresholds or turn a confident `auto` into `auto + undo` (profile diffs and inbox classifications do by default). Agents pass `confidence` on medium-impact tool calls; without it the op queues for the human. System One models answer typed questions only; they never write text.
4. **Never submit an application or send an email.** Gmail is read plus draft only. Applications end at **Open portal**; outreach ends at **Create Gmail draft**. LinkedIn automation is read-only, capped, slow, and never messages or connects.
5. **No personal data in this repo.** Nothing from a user's profile, pipeline, applications, interviews, resume, `.docx` or vault is ever committed. Fixtures are synthetic. Tests use temp dirs and never touch the real `PP_HOME`. `.gitignore` blocks vaults, `*.db`, `.env`, resumes, `.pdf` and `.docx`; do not weaken it.
6. **Writing in the user's voice:** no em dashes; punchy (hook, reframe, close). Grounded in the Story and Voice components only; never invent facts.
7. **UI copy:** no explanatory text, no tips, labels of one to three words (buttons and labels; onboarding interview questions are full sentences with an optional one-line example, wave1-decisions #28). One primary action per screen. Every button calls exactly one op. Dark only, tokens from `@perfect-placement/contracts`.
8. **No-downgrade:** automated actors never move a role backwards out of `draft-ready` or later, and a rescore never moves an `on-deck` pick.

## How to run

```
./install.sh                    # prerequisites, pnpm install + build, `pp` + `pp-mcp` launchers in ~/.local/bin (--check: report only)
pp setup                        # vault at PP_HOME (default ~/.perfect-placement), optional Kev (offers to install uv), MCP for detected agents, schedule jobs (asks), then a pass/fail summary (--yes, --no-kev, --no-mcp, --no-schedules)
pp up                           # API /api/ops, Ask /api/ask (agent session, SSE), MCP /mcp, web UI on http://127.0.0.1:5177; starts Kev if installed (--no-kev)
pp up --fixtures                # demo on synthetic data
pp doctor                       # integrity checks
pp op <name> --input '<json>'   # any op
pp drain                        # launch queued skill runs once (pp up does it continuously)
pp run <skill> [--schedule]     # queue a skill run, drain until it (and what it triggers) finishes; what schedule jobs run
pp schedules install|remove|status   # config.schedules as OS jobs (launchd / systemd user timers); pp setup offers it
pp kev install|start|stop|status

corepack enable                 # development: pnpm version pinned in package.json
pnpm i && pnpm build && pnpm test && pnpm lint
pnpm --filter @perfect-placement/fixtures gen   # after editing fixtures/src/data.ts
```

(`pp` is the CLI bin; without the launcher use `node packages/cli/dist/index.js ...`.)

- Node 22+. `better-sqlite3` is native: on macOS it needs the Xcode command line tools if no prebuilt binary matches.
- **Kev** (local decision model): `pp kev install` puts it in `$PP_HOME/kev/`; `pp up` starts it on demand and stops it on exit only if it started it. Model in `config.backends.kev.model`. Background: `packages/resolver/docs/kev-setup.md`.
- **Agents (Claude Code, Codex, Cursor, Claude Desktop):** `pp setup` registers the stdio `pp-mcp` server (key `pp`, absolute node + bin, `PP_HOME` env) after asking; manual snippets in `packages/mcp/README.md`. Tool names use underscores (`roles_list`) because all three clients mishandle dots; op names stay dotted. `runs.start` queues a headless runner from `config.runner` (`claude`, `codex` or `cursor-agent`); the run queue launches it (`config.runs.max_concurrent`), and the pipeline chains scout -> score -> research (`config.pipeline`). The runner passes `PP_RUN_ID` to the pp MCP server, so a headless run's ops and events carry its run id. Schedules run as OS jobs (`pp schedules`, see `packages/cli/README.md`); `pp up` queues any schedule missed since its last run.
- **Tests never touch real machine state:** `pp setup` / `pp kev` take an injected `SystemDeps` (temp HOME, fake spawn, no network); `install.sh` is tested with `--check` only. CI job `fresh-install` runs the real `./install.sh` and `scripts/fresh-install-smoke.sh` (setup, up, write, restart, read back).
- **Web dev:** `pnpm --filter @perfect-placement/web dev` (port 5178) proxies `/api` to `pp up` on 5177; `dev:mock` runs on read-only fixtures.
- **OpenUI telemetry:** set `OPENUI_TELEMETRY_DISABLED=1` in your shell; root `package.json` also blocks its install script (`pnpm.onlyBuiltDependencies`). Never add `@openuidev/lang-core` to that list.

## How work merges

- **Waves:** Wave 0 (contracts), Wave 1 (lanes A to J), Wave 2 (integrate) are done in code; Fresh start (wave1-decisions #26): no v1 data is imported; the first real run follows `docs/v2/wave2-plan.md`, "Fresh-start runbook", with the owner present. Wave 3 is next.
- **One branch per piece of work**, in its own worktree. Open a PR when the branch is finished and ready to close; merge through the PR, then delete the branch and worktree. No big-bang PRs.
- **Contracts:** `packages/contracts` and migrations change only through `CONTRACT_CHANGES.md` (request, then a resolution with a Status). New schema changes are new numbered migrations; never edit an applied one.
- **Develop against fixtures** (`@perfect-placement/fixtures`, or `@perfect-placement/engine/testing` for a real engine on a temp fixtures vault). Tests never touch the real `PP_HOME`.
- **Real-data steps** (first scout + score, rescore, schedules, live LinkedIn or Gmail) only with the owner present.

## Conventions

- TypeScript strict, ESM, zod as the single schema source (JSON Schema for MCP via `opInputJsonSchema`).
- Ids are TEXT. Role id = `<company-slug>_<title-slug>`; company id = slug; everything else `<prefix>_<ulid>` (`ID_PREFIX`).
- Timestamps ISO 8601 UTC. `*_json` columns hold JSON; booleans are 0/1 (`BOOLEAN_COLUMNS`).
- Every vault markdown file starts with frontmatter `id` + `type`; structured fields live in the db, never parsed from markdown.
- `score` and `event` are append-only (enforced by triggers).
