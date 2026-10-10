# Wave 0: contracts

Wave 0 is one agent, sequential. Its job is to produce contracts so the ten Wave 1 lanes can work in parallel against fixtures without asking anyone anything. Keep implementations thin: types, schemas, stubs, fixtures, and a test that the contracts compile. No feature work.

## Step 0: confirm the repo with Wassim

Ask one question before anything else: build the system in a **new repo** (recommended; this repo stays the private v1 archive and its history keeps personal data out of the system) or **in this repo**. If new: ask for the folder and repo name, create it, copy `docs/v2/` into it as `docs/v2/`.

## Repo layout (system repo)

```
AGENTS.md                  # operating manual (no CLAUDE.md anywhere)
CONTRACT_CHANGES.md        # lanes request contract changes here
package.json               # pnpm workspaces
pnpm-workspace.yaml
tsconfig.base.json
packages/
  contracts/               # Wave 0 owns: zod schemas, op definitions, events, statuses, policy types
  engine/                  # lanes A (db/), B (ops/, status/), E (profile/), F (scoring/), G (integrations/ats/), H (people/)
  resolver/                # lane I
  mcp/                     # lane C
  cli/                     # lane B (thin)
  fixtures/                # Wave 0 owns: synthetic vault + db seed
apps/
  web/                     # lane D (genui/ subfolder: lane J)
skills/
  <name>/SKILL.md          # agent-agnostic skills (owned per lane)
docs/v2/                   # this handoff
.gitignore                 # must ignore any vault, *.db, .env, resumes, docx
```

## Tooling defaults

Defaults, not dogma. A lane may deviate only via `CONTRACT_CHANGES.md`.

- Node 22 LTS or newer, pnpm workspaces, TypeScript `strict`.
- **zod** is the single source for every schema. JSON Schema is generated from zod for MCP tools.
- SQLite via `better-sqlite3`; migrations as numbered SQL files in `packages/engine/db/migrations/`.
- Tests: Vitest. Lint: Biome or ESLint, pick one in Wave 0.
- MCP: `@modelcontextprotocol/sdk` (stdio + Streamable HTTP).
- Web: React + Vite; local API served by the same process as the MCP HTTP transport (`pp up`).
- Python is allowed only for Kev serving (external process).

## Data home

`PP_HOME` (default `~/.perfect-placement`):

```
pp.db
config.json                # thresholds, backends, schedules, caps
profile/<component>.md     # long-form per component (Story, Voice)
companies/<slug>/dossier.md
roles/<role_id>.md         # JD capture + notes
applications/<role_id>/{resume.md,cover_letter.md,fit_map.md,answers.md}
interviews/<role_id>/{prep.md,retro-<n>.md}
outreach/<contact_id>-<role_id>.md
files/                     # resume.pdf, .docx renders
runs/<date>_<op>.md        # human-readable run logs (db is canonical)
```

Every markdown file starts with YAML frontmatter containing `id` (and `type`). The db row stores the vault-relative path. Markdown is never parsed for structured fields; the db is.

## Schema v1 (sketch; Wave 0 writes the real migration)

```
profile_version(id, created_at, parent_id, reason, event_id)
profile_component(id, version_id, key, kind[filter|weighted|asset], confidence, weight, data_json, md_path)
company(id, slug, name, domain, ats_type, ats_board, affinity, md_path)
role(id, company_id, title, url, ats_job_id, source, found_at, posted_at, workplace, remote_ok,
     comp_min, comp_max, facing, seniority, status, archive_reason, held_reason,
     last_checked_at, freshness[open|closed|unsure|unknown], md_path)
score(id, role_id, profile_version_id, rubric_json, c1..c9, affinity_mod, total, band, decision, created_at)  -- append-only
event(id, ts, type, subject_type, subject_id, payload_json, actor[agent|human|schedule], decision_id)
application(id, role_id, stage, applied_at, portal_url, package_paths_json)
contact(id, name, headline, linkedin_url, email, source, notes, email_source[gmail|linkedin|public|pattern|provider|manual], email_confidence)
contact_link(id, contact_id, company_id, role_id, degree[1|2|cold], tier, via_contact_id, is_hiring_team)
outreach(id, contact_id, role_id, tier, gmail_draft_id, status[drafted|in_gmail|replied|ignored], md_path)
interview(id, role_id, round, at, prep_path, retro_path, outcome)
decision(id, ts, kind, subject_type, subject_id, question_json, backend, answer_json, p, impact,
         policy_outcome[auto|auto_second|auto_undo|human], human_choice, overridden, undo_until, latency_ms)
run(id, op, started_at, finished_at, status, summary_json, log_path)
```

## Ops (the registry)

Each op is defined once in `packages/contracts/ops/` as `{ name, input: zod, output: zod, impact: 'low'|'medium'|'high', emits: EventType[], description }`. UI, MCP, CLI and skills all call ops through one `runOp(name, input, ctx)` entry point that validates, applies policy, writes `event` rows, and returns typed output. Starting list:

| Op | Impact | Notes |
| --- | --- | --- |
| `profile.get`, `profile.history` | low | read |
| `profile.propose_diff` | low | creates a pending diff |
| `profile.apply_diff` | per diff: weights medium, filters/dealbreakers high | |
| `profile.set_defaults` | low | Application defaults (Terms `application_defaults`): a human edit applies as v+1, never rescored (#42) |
| `onboard.ingest_resume`, `onboard.answer`, `onboard.calibrate`, `onboard.confirm` | low | |
| `roles.add` | low | dedupe: url, ats job id, company+title (fuzzy); intake check skips dead postings, resolves aggregator links to the company's ATS posting (#32); per scout run, watchlist adds capped at ceil(share x target) and `max_per_company` (#67) |
| `scout.watchlist_scan` | low (read) | every open role on each watchlist company's Greenhouse / Lever / Ashby board, rule-filtered, ranked by fit, near-identical titles grouped, at most `scout.max_per_company` per company, as roles.add candidates (#28, #67) |
| `roles.score` | low | writes score row, sets active/held/archived |
| `roles.move` | medium | status change with no-downgrade guard |
| `roles.archive` | medium | requires reason |
| `roles.check_freshness` | medium (if closing) | |
| `roles.get`, `roles.list`, `pipeline.summary` | low | read |
| `companies.dossier.write` | low | |
| `apply.tailor` | low | writes package, moves to draft-ready; unsupported prose claims queue `apply.fact_check` decisions (#54) |
| `apply.fill` | low | answers file: portal fills, standard answers from Application defaults, fact-checked written answers; needs-you only with a reason (#42); `source` `fill` / `ask` per answer, Ask saves merge (#81) |
| `apply.resolve_claim` | low | keep / remove / rewrite the line of an unsupported claim (the `apply.fact_check` action, #54) |
| `apply.mark_submitted` | high | human only |
| `apply.skip_connect` | low | application `connect` -> `fill` with a reason, so a role never stalls (#78) |
| `apply.set_questions` | low | save pasted portal questions (`questions.md`) and queue a fill run that answers them instead of reading the portal (#81) |
| `people.find` | low | runs LinkedIn adapter (rate-limited) |
| `people.link`, `people.classify` | low | |
| `people.find_email` | low | known address or a ranked pattern guess with a confidence; unsure guesses queue a `people.email` decision (#37) |
| `people.fallback` | low | no usable contact: hiring-team / recruiting address, else cold hiring leader (guessed email), else skip Connect (#78) |
| `outreach.draft` | low | vault draft |
| `outreach.to_gmail` | medium | creates a Gmail **draft**; To only when the address is confirmed or confident (#37) |
| `outreach.send` | high | not implemented in v2; human sends from Gmail |
| `inbox.ingest` | medium | classify + move |
| `decisions.queue`, `decisions.resolve`, `decisions.undo`, `decisions.undo_group` | low / per item | the Needs-you queue; `auto_groups` and group undo for Now's Auto stream (#103) |
| `runs.list`, `runs.get` | low | |
| `system.doctor` | low | |

## Events

`role_added`, `role_scored`, `role_moved`, `role_archived`, `role_held`, `role_promoted`, `freshness_checked`, `role_closed`, `role_picked`, `role_skipped`, `application_tailored`, `application_submitted`, `inbox_classified`, `interview_scheduled`, `interview_retro`, `rejection`, `offer`, `contact_found`, `outreach_drafted`, `outreach_replied`, `profile_diff_proposed`, `profile_diff_applied`, `profile_diff_rejected`, `decision_made`, `decision_overridden`, `decision_undone`, `run_started`, `run_finished`.

## Resolver interface

```ts
type Question =
  | { id: string; type: 'choice'; instructions: string; options: string[] }   // always include an 'other'
  | { id: string; type: 'noulli'; instructions: string }
  | { id: string; type: 'score'; instructions: string; min: number; max: number };

interface AskRequest { decision: DecisionKind; impact: Impact; state: string | Record<string,string>; questions: Question[]; subject?: { type: string; id: string } }
interface Answer { id: string; value: string | boolean | number; p: number }
interface AskResult { answers: Answer[]; backend: 'rule'|'jev'|'kev'|'llm'|'human'; latencyMs: number; decisionIds: string[] }

ask(req: AskRequest): Promise<AskResult>
decide(answer: Answer, impact: Impact, thresholds): 'auto' | 'auto_second' | 'auto_undo' | 'human'
```

- Backends implement one interface. Jev and Kev share a System One HTTP adapter (base URL + key).
- Rule backend handles numbers and dates (comp floor, posting age).
- Every call writes `decision` rows. `human` outcomes land in the Needs-you queue with the pick and p attached.

## Policy config (`config.json`)

```json
{
  "policy": { "auto": 0.90, "second_opinion": 0.70, "undo_hours": 24 },
  "overrides": { "freshness.closed": { "auto": 0.92 } },
  "backends": { "default": "jev", "fallback": "kev", "jev": { "baseUrl": "", "keyEnv": "JEV_API_KEY" }, "kev": { "baseUrl": "http://127.0.0.1:8009" }, "llm": { "provider": "anthropic" } },
  "scoring": { "affinity_cap": 5, "company_active_cap": 3, "green_min": 75, "yellow_min": 55 },
  "scout": { "watchlist_share_max": 0.34, "target_new_roles": 25, "max_queries": 30 },
  "linkedin": { "max_profiles_per_day": 40, "min_delay_s": 20 },
  "schedules": { "inbox": "daily 07:30", "freshness": "daily 06:30", "scout_score": "fri 05:30" }
}
```

`scout.max_per_company` is optional: the most roles one watchlist company adds per scout run (default `scoring.company_active_cap` + 2).

## Design tokens

Wave 0 copies the final tokens from the Claude Design handoff into `packages/contracts/tokens.ts` (and a CSS variables file for `apps/web`). Baseline if the handoff is missing: bg #06111F, bg-2 #091A2D, panel #0C1F36, panel-2 #11284A, line #1A3557, line-2 #26486F, fg #E6EEF6, muted #8EA3BB, dim #5C7491, emerald #2FD39B, emerald-2 #17A77A, emerald-deep #0B5C45, emerald-ink #04291F, gold #E2B65A, coral #EF7D7D, sky #7FB6FF. Fonts: Bricolage Grotesque (display), Figtree (UI), JetBrains Mono (labels, numbers).

## Fixtures

`packages/fixtures/` holds a **synthetic** vault + seed SQL: one profile (11 components), ~30 roles across all statuses and ~12 companies (public company names and real-looking titles are fine; people are placeholders like "Maya R."), scores, a few contacts and outreach drafts, a few pending decisions of each kind. Every lane develops against it. Never copy real data from the v1 repo into fixtures.

## AGENTS.md

Write the system's operating manual. Must include: what the system is, the layout above, ops-only writes, judgment vs mechanics, the decision policy, personal-data rule, no em dashes in user-facing writing in Wassim's voice, never submit or send, how to run (`pp up`, `pp doctor`), how lanes coordinate (worktrees, owned folders, `CONTRACT_CHANGES.md`). No personal facts about Wassim.

## Wave 0 done when

- `pnpm i && pnpm -r build && pnpm -r test` passes on a clean clone.
- `packages/contracts` exports statuses, events, ops (all from the table, stubbed), resolver types, policy types, tokens.
- Migration 001 creates the schema; fixtures load into a temp db.
- `AGENTS.md` written; no `CLAUDE.md` in the repo; `.gitignore` covers vault, db, env, resumes.
- Empty package skeletons exist for every lane with a README naming the owner lane.
- One git branch per lane created from the Wave 0 commit: `v2/lane-a` ... `v2/lane-j`.
