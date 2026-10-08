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
  engine/               openEngine(): db/ (repos, migrations, vault, doctor, v1 migrate)  ops/ (runOp + handlers)  status/  profile/  scoring/  freshness/  people/  integrations/
  resolver/             decision layer: rule, Kev, agent, human; policy; decision ops
  mcp/                  MCP server generated from ops (stdio `pp-mcp`, HTTP at /mcp)
  cli/                  `pp`: up, init, doctor, migrate, op, scout, score, fresh, inbox
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
7. **UI copy:** no explanatory text, no tips, labels of one to three words. One primary action per screen. Every button calls exactly one op. Dark only, tokens from `@perfect-placement/contracts`.
8. **No-downgrade:** automated actors never move a role backwards out of `draft-ready` or later, and a rescore never moves an `on-deck` pick.

## How to run

```
corepack enable                 # pnpm version pinned in package.json
pnpm i && pnpm build && pnpm test && pnpm lint
pnpm --filter @perfect-placement/fixtures gen   # after editing fixtures/src/data.ts

node packages/cli/dist/index.js up --fixtures   # demo on synthetic data: http://127.0.0.1:5177
node packages/cli/dist/index.js init            # create a vault at PP_HOME (default ~/.perfect-placement)
node packages/cli/dist/index.js up --kev        # API /api/ops, MCP /mcp, web UI; reports Kev reachability
node packages/cli/dist/index.js doctor          # integrity checks
node packages/cli/dist/index.js op <name> --input '<json>'
```

(`pp` is the CLI bin; `pnpm --filter @perfect-placement/cli exec pp ...` also works.)

- Node 22+. `better-sqlite3` is native: on macOS it needs the Xcode command line tools if no prebuilt binary matches.
- **Kev** (local decision model, kev-4b via MLX): see `packages/resolver/docs/kev-setup.md`. `pp up` never starts it.
- **Agents (Claude Code, Codex, Cursor):** configure the MCP server per `packages/mcp/README.md` (stdio `pp-mcp` or HTTP `/mcp`). Tool names use underscores (`roles_list`) because all three clients mishandle dots; op names stay dotted. `runs.start` launches a headless runner from `config.runner` (`claude`, `codex` or `cursor-agent`).
- **Web dev:** `pnpm --filter @perfect-placement/web dev` (port 5178) proxies `/api` to `pp up` on 5177; `dev:mock` runs on read-only fixtures.
- **OpenUI telemetry:** set `OPENUI_TELEMETRY_DISABLED=1` in your shell; root `package.json` also blocks its install script (`pnpm.onlyBuiltDependencies`). Never add `@openuidev/lang-core` to that list.

## How work merges

- **Waves:** Wave 0 (contracts), Wave 1 (lanes A to J), Wave 2 (integrate) are done in code; Wave 2's real-data steps run with the owner present (`docs/v2/wave2-plan.md`, "Stop line runbook"). Wave 3 is next.
- **One branch per piece of work**, in its own worktree. Open a PR when the branch is finished and ready to close; merge through the PR, then delete the branch and worktree. No big-bang PRs.
- **Contracts:** `packages/contracts` and migrations change only through `CONTRACT_CHANGES.md` (request, then a resolution with a Status). New schema changes are new numbered migrations; never edit an applied one.
- **Develop against fixtures** (`@perfect-placement/fixtures`, or `@perfect-placement/engine/testing` for a real engine on a temp fixtures vault). Tests never touch the real `PP_HOME`.
- **Real-data steps** (migrate, rescore, freshness backfill, schedules, live LinkedIn or Gmail) only with the owner present.

## Conventions

- TypeScript strict, ESM, zod as the single schema source (JSON Schema for MCP via `opInputJsonSchema`).
- Ids are TEXT. Role id = `<company-slug>_<title-slug>`; company id = slug; everything else `<prefix>_<ulid>` (`ID_PREFIX`).
- Timestamps ISO 8601 UTC. `*_json` columns hold JSON; booleans are 0/1 (`BOOLEAN_COLUMNS`).
- Every vault markdown file starts with frontmatter `id` + `type`; structured fields live in the db, never parsed from markdown.
- `score` and `event` are append-only (enforced by triggers).
