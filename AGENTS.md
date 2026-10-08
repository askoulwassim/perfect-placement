# Perfect Placement: operating manual for agents

This is the only agent instruction file in this repo. **There is no CLAUDE.md anywhere, and there must never be one** (decisions.md #8): Claude Code reads AGENTS.md only when no CLAUDE.md exists in the working directory or any parent. `pp doctor` checks the parent chain.

## What this is

A local job-search system. It scouts roles, scores them against a learned profile, keeps the pipeline fresh, tailors applications, finds people who can open doors, watches the inbox, and learns from outcomes. The repo holds **only the system**. Each user's data lives in a local vault at `PP_HOME` (default `~/.perfect-placement`): SQLite (`pp.db`) for structure, markdown for long-form, linked by id. The web UI, the MCP server, the `pp` CLI and scheduled runs all call **one ops registry**, so anything a human can click, an agent can do.

Full brief: `docs/v2/` (start with `README.md`, then `decisions.md`; locked means locked).

## Layout

```
AGENTS.md               this file
CONTRACT_CHANGES.md     contract change requests from lanes
packages/
  contracts/            zod schemas, statuses, events, ops registry, resolver + policy types, design tokens, UI inventory
  engine/               db/ (A)  ops/ status/ (B)  profile/ (E)  scoring/ (F)  freshness/ integrations/ats/ (G)  people/ integrations/{linkedin,gmail}/ (H)
  resolver/             decision layer (I)
  mcp/                  MCP server generated from ops (C)
  cli/                  `pp` (B; migrate + doctor: A)
  fixtures/             synthetic vault + db seed (Wave 0)
apps/web/               UI (D); genui/ (J)
skills/<name>/SKILL.md  agent-agnostic skills
docs/v2/                the build brief
```

## Rules

1. **Every write is an op.** Nothing edits `pp.db` or the vault except op handlers called through `runOp(name, input, ctx)`. Skills, UI, MCP and CLI never write directly.
2. **Model supplies judgment, code supplies mechanics.** Skills produce search hits, 1 to 5 scores, classifications and drafted text, then call ops. Totals, bands, dedupe, status moves, counts, run logs and validation are code.
3. **Decisions go through the resolver.** A human never sees a blank question: they see the pick and its probability. Policy (confidence x impact, thresholds in `config.json`):

   | Impact \ p | >= 0.90 | 0.70 to 0.90 | < 0.70 |
   | --- | --- | --- | --- |
   | Low (reversible, internal) | auto | auto if a second backend agrees | human |
   | Medium (reversible, visible) | auto + 24h undo | human | human |
   | High (external or irreversible) | human | human | human |

   High impact: submit an application, send an email, delete anything, change a dealbreaker, change the comp floor. System One models (Jev, Kev) answer typed questions only; all writing uses an LLM.
4. **Never submit an application or send an email.** Gmail is read plus draft only. Applications end at **Open portal**; outreach ends at **Create Gmail draft**. LinkedIn automation is read-only, capped, slow, and never messages or connects.
5. **No personal data in this repo.** Nothing from a user's profile, pipeline, applications, interviews, resume, `.docx` or vault is ever committed. Fixtures are synthetic. Tests use temp dirs and never touch the real `PP_HOME`. `.gitignore` blocks vaults, `*.db`, `.env`, resumes, `.pdf` and `.docx`; do not weaken it.
6. **Writing in the user's voice:** no em dashes; punchy (hook, reframe, close). Grounded in the Story and Voice components only; never invent facts.
7. **UI copy:** no explanatory text, no tips, labels of one to three words. One primary action per screen. Every button calls exactly one op. Dark only, tokens from `@perfect-placement/contracts`.
8. **No-downgrade:** automated actors never move a role backwards out of `draft-ready` or later.

## How to run

```
corepack enable            # pnpm version pinned in package.json
pnpm i
pnpm build                 # pnpm -r build
pnpm test                  # pnpm -r test
pnpm lint                  # biome
pnpm --filter @perfect-placement/fixtures gen   # after editing fixtures/src/data.ts
pp up                      # API + MCP (HTTP) + web, once lane B lands
pp doctor                  # integrity checks, once lane A lands
```

Node 22+. `better-sqlite3` is native: on macOS it needs the Xcode command line tools if no prebuilt binary matches.

## How lanes coordinate

- **Waves:** Wave 0 (contracts, done) -> Wave 1 (lanes A to J in parallel) -> Wave 2 (integrate, cut over) -> Wave 3.
- **One worktree per lane** on its branch `v2/lane-<x>`: `git worktree add ../pp-lane-a v2/lane-a`.
- **Owned folders:** a lane writes only inside the folders its brief (`docs/v2/lanes/<X>-*.md`) and the folder README name. Each skeleton folder has a README naming its owner.
- **Contracts are frozen per wave.** Never edit `packages/contracts` (or migration 001) from a lane. Append a request to `CONTRACT_CHANGES.md`; work against a local shim until Wave 2 resolves it.
- **Develop against fixtures** (`@perfect-placement/fixtures`): copy the vault to a temp dir, apply migrations, then the seed SQL.
- **Done** = passing build and tests on the lane branch plus a short report: what shipped, deviations, open questions, what Wave 2 needs. Do not merge.

## Conventions

- TypeScript strict, ESM, zod as the single schema source (JSON Schema for MCP via `opInputJsonSchema`).
- Ids are TEXT. Role id = `<company-slug>_<title-slug>`; company id = slug; everything else `<prefix>_<ulid>` (`ID_PREFIX`).
- Timestamps ISO 8601 UTC. `*_json` columns hold JSON; booleans are 0/1 (`BOOLEAN_COLUMNS`).
- Every vault markdown file starts with frontmatter `id` + `type`; structured fields live in the db, never parsed from markdown.
- `score` and `event` are append-only (enforced by triggers).
