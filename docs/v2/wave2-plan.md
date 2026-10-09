# Wave 2 plan: contract resolutions + integration

Branch: `v2/wave2` (all ten lanes merged A, B, I, E, F, G, H, C, D, J; build/test/lint green at merge). Inputs: `CONTRACT_CHANGES.md`, `wave1-decisions.md` (#1 to #25), lane briefs, `W2-integrate.md`.

**Stop line:** nothing in Wave 2 automation touches real data: no real PP_HOME, no scoring of real roles, no scheduled tasks created, no LinkedIn/Gmail live calls, no real-role run. Those are the Wassim-present steps at the end (see "Fresh-start runbook"). Since #26 there is no v1 import: the system starts empty.

## Phase 1: contracts (one agent)

Resolve every entry in `CONTRACT_CHANGES.md` by setting its `Status:` line, then implement accepted ones in `packages/contracts`, migration `002_wave2.sql`, and regenerate fixtures. Resolutions:

| Request | Resolution |
| --- | --- |
| B runs.finish | accepted |
| B role_promoted in more emits | accepted (apply.tailor, apply.mark_submitted, inbox.ingest, roles.check_freshness) |
| B record() on Resolver | accepted: `Resolver.record(req)` for externally judged answers |
| B archive reason `duplicate` | accepted |
| B roles.add possible_duplicates | accepted |
| B OpContext.confidence | accepted (`{ p, backend }`); powers decision #17 |
| I typed DecisionAction | accepted: `DecisionAction = { op, input, when?, undo? }`; `Decision.action_json: DecisionAction \| null` |
| I/E/G/B AskRequest action(s) | amended into one: `AskRequest.action?: DecisionAction` (all questions) and `AskRequest.actions?: Record<questionId, DecisionAction>` (per question wins) |
| I fixture dc_0001 / dc_0101 | accepted (`when: false` on dc_0001; `undo` on dc_0101) |
| I decision repository owner | lane A's repository implements lane I's `DecisionStore` interface (no contract change) |
| E COMPONENT_DATA_SCHEMAS | accepted: move from engine/profile/components.ts into contracts (loose objects) |
| E/F criterion ownership | amended: `CRITERION_OWNER` = c1, c7 team; **c2, c3, c9 craft**; c4, c5 domain; c6 terms; c8 growth (F's mapping: C2 is scored blind, so it is role-intrinsic). Field name **`criterion_weights`** (points of 100). |
| E onboard_session table | accepted (migration 002) |
| E onboard.start, onboard.samples; D onboard.samples, onboard.state | accepted, merged: `onboard.samples` items `{ id, company, letter, title, comp, mode, criteria }` + baseline `weights`; `onboard.state` returns current OnboardState |
| E onboard.confirm proposed_diffs | accepted |
| E profile.undo_diff | accepted; `decisions.undo` dispatches through `DecisionAction.undo` |
| E profile.learn | accepted |
| E ProfileDiff.event_id meaning | accepted (doc comment) |
| F RubricSnapshot | accepted, default `scale: 'v1'` (decision #11). Regenerate fixtures with the v1 formula and re-check band consistency. |
| F roles.score profile_version_id + cap output | accepted |
| F RESCORE_MOVABLE / REVIVABLE | accepted; on-deck protected from rescore (decision #13) |
| G check_freshness skipped | accepted |
| H people.find hints + slug | accepted |
| H people.classify outcome | accepted (`outcome: PolicyOutcome`) |
| H classify decision action | accepted via DecisionAction (`people.link`) |
| H config.linkedin mode/driver/caps | accepted; defaults `mode: 'live'` (decision #6 on by default), `driver: 'claude-in-chrome'` (#4), `max_pages_per_run: 6`, `max_mutual_expansions: 3`. Tests use `dry-run`. |
| C companies.get | accepted |
| D outreach.get (with 4 tone variants) | accepted |
| D outreach.list | accepted as `outreach.list { role_id }` |
| D contacts.get | accepted |
| D vault.read | accepted, restricted to paths the db references |
| D system.backends | amended: items `{ name: 'rule'\|'kev'\|'jev'\|'agent', mode, status, latencyMs }`, owner I |
| D runs.start contact_id | accepted |
| D schedules off | accepted: each schedule is `string \| 'off'` |
| D PRIMARY_ACTIONS wording | accepted |
| D API route | accepted: `POST /api/ops/:name`, JSON body, returns `OpOutcome`, actor human |
| D extra tokens | accepted: add to tokens.ts (tints, shadows, 720px breakpoint) and regenerate tokens.css |
| J card prop schemas | accepted (id-only zod schemas in ui.ts) |
| J fold genui into build | Phase 3 (integration, not contract) |

Decisions that change contracts (Phase 1 implements):
- **#7 / #9 Kev only, agent instead of API.** `BACKENDS` gains `'agent'` (the calling Claude / Codex / Cursor session). DEFAULT_CONFIG.backends: `{ default: 'kev', fallback: 'agent', kev: { baseUrl: 'http://127.0.0.1:8009' }, jev: { baseUrl: '', keyEnv: 'JEV_API_KEY', enabled: false }, agent: {} }`. Remove the Anthropic `llm` provider from defaults (keep the backend name `llm` only if lane I's optional API adapter stays, disabled by default). Add `config.runner: { command: 'claude' \| 'codex' \| 'cursor-agent', args?: string[] }` default `claude` for headless runs.
- **#24 policy grid.** `POLICY_GRID` = low: auto / auto / auto_undo; medium: auto / auto_second / human; high: auto_undo / human / human. Add `HARD_HUMAN` exclusions (not tunable): decision kind `apply.submit`, op `outreach.send`, any delete, `profile.apply_diff` on `dealbreakers`, and on `terms` when `comp_floor` changes. Export `isHardHuman({ kind, op?, component?, changedKeys? })`. Migration 002 rebuilds the `decision` table to replace the CHECK `impact <> 'high' OR policy_outcome = 'human'` with `kind <> 'apply.submit' OR policy_outcome = 'human'`.
- **#14** asset components' diffs are medium impact (`COMPONENT_DIFF_IMPACT`: filter high, weighted medium, asset medium).
- **#10** dream-company affinity default `+3` (`DREAM_AFFINITY = 3`).
- **#20** add flag convention `flags_json.verify_remote: true`.

Phase 1 done when: all entries have a Status, contracts + migration 002 + fixtures updated, `pnpm build && pnpm test && pnpm lint` green (fix any lane code that breaks on the new types without changing behavior beyond the contract).

## Phase 2: engine integration (one agent)

- Replace every `WAVE2-SHIM` / `_shim` / `testkit` stand-in with the real pieces: lane A repositories + migration runner as the only db access; lane B `runOp` as the only write path; lane I resolver + `DecisionStore` (implemented over lane A repos) + decision ops; register E, F, G, H handlers in the registry; lane F `rebalanceCompany` after moves/archives/closes; lane E `deps.rescore` -> lane F; lane I `decisions.undo` -> `DecisionAction.undo`.
- Resolver backends per #7/#9: rule -> Kev -> agent (returns `needs_agent`, i.e. the calling session must answer through the op input or the decision goes to Needs you) -> human. Jev and the Anthropic API adapter stay in code, disabled by default. Second opinion (`auto_second`) uses the agent backend when present, else human.
- Behavior decisions: #13 on-deck protected + not counted in cap, #16 confirmation revives archived -> applied (auto + undo), #17 agent medium ops go through the grid using `ctx.confidence`, #18 draft-ready closes follow the grid, #24 grid + hard exclusions, #14 asset diffs medium, #20 migration tags `verify_remote`, #10 migration/converter sets dream affinity +3 and lane A's profile import uses lane E's `convertV1Profile`.
- Learn loop end to end on fixtures: event -> resolver (Noulli x 11) -> diff -> policy -> profile v+1 -> rescore affected roles. One integration test.
- `runs.start` launches the configured headless runner (`claude -p` / `codex exec` / `cursor-agent`) with the skill and the MCP server; injectable spawn, tests use a fake. Never runs in CI.
- Full fixture e2e via ops only: inbox -> score -> active -> research -> tailor -> connect (dry-run) -> fill -> draft-ready; `apply.mark_submitted` human-only -> applied; `inbox.ingest` confirmation/interview.

## Phase 3: surfaces (two agents in parallel worktrees)

- **3a pp up + MCP + CLI** (packages/cli, packages/mcp): `pp up` serves `POST /api/ops/:name`, mounts MCP Streamable HTTP at `/mcp`, serves `apps/web/dist`; MCP stdio uses the real `runOp`; `pp doctor` wired; MCP config snippets for Claude Code, Codex, Cursor verified against current docs; tool names tested dotted vs underscore.
- **3b web live** (apps/web incl. genui): switch the client to live ops (`VITE_PP_API`), remove mock-only mechanics, fold genui into the apps/web build (OpenUI 0.3.2 pinned, lang-core install script stays blocked, devtools stubbed, `OPENUI_TELEMETRY_DISABLED=1` documented), Ask reply cards with PRIMARY_ACTIONS buttons (#23), Settings policy grid shows the #24 grid with hard exclusions locked.

## Phase 4: verify + docs (me)

Clean-clone build/test/lint; `pp up` against a temp fixtures vault smoke test (UI loads, an op round-trips, MCP lists tools); AGENTS.md updated (Kev, agent backend, runner, telemetry opt-out, Codex/Cursor); no v1 scripts in the repo; push `v2/wave2`; open a PR to `main` (not merged).

## Fresh-start runbook (Wassim present)

No v1 data is imported (wave1-decisions #26). The system starts empty and fills from real use.

1. **Start Kev** (`packages/resolver/docs/kev-setup.md`); `pp up --kev` must report it reachable.
2. **`pp init`** into the real `~/.perfect-placement` (outside any git repo), then `pp doctor`: all green, 0 roles.
3. **Onboarding** in an agent session over MCP (`skills/onboard`): resume, interview, calibrate, confirm. Profile version 1 lands with all 11 components and criterion weights.
4. **First scout + score** via an agent session (`skills/scout`, `skills/score`): roles enter the inbox and are scored into active / held / archived; check the per-company cap and bands look right.
5. **Schedules:** create the three (`inbox` daily 07:30, `freshness` daily 06:30, `scout_score` Fri 05:30) from Settings or `config.json`.
6. **One real role end to end** (#3 to #6): pick on-deck, research, tailor, connect (LinkedIn read-only), fill, Open portal; Wassim submits; the confirmation email moves it to applied.
7. **UI sign-off** against the Claude Design prototype.
