# packages/engine/ops

**Owner: lane B** (`docs/v2/lanes/`). The integration point: `runOp(name, input, ctx)` is the only way anything writes `pp.db` or the vault, and every op in the registry has a handler here (lanes A, B, E, F, G, H, I).

## Engine factory (what surfaces call)

```ts
import { openEngine } from '@perfect-placement/engine';
const engine = openEngine({ home?: string, services?: EngineServices }); // creates the vault + applies migrations
const outcome = await engine.runOp('roles.list', { status: ['active'] }, { actor: 'agent', now: () => new Date() });
// outcome: { status: 'ok', output, eventIds } | { status: 'requires_human', decisionId } | { status: 'error', code, message, issues? }
engine.close();
```

`engine.runOp` has the contract `RunOp` signature, so it plugs straight into the MCP server and `pp up` (`POST /api/ops/:name`). One engine per vault per process; top-level writes are serialized on its connection.

`EngineServices` (all optional; production defaults are the real ones): `fetch` (freshness ladder), `backends` (resolver backend overrides), `env` (KEV_API_KEY, JEV_API_KEY, ANTHROPIC_API_KEY), `profileLlm` (writing model for profile.learn; absent = the learn skill drafts), `linkedin`, `gmail`, `gmailContacts`, `outreachWriter`, `launcher` (headless runner), `freshnessDelayMs`, `sleep`. Tests use `@perfect-placement/engine/testing` (`openFixtureEngine`, `fakeBackend`, `fakeLauncher`, `noNetwork`): never the network, Kev, LinkedIn, Gmail or a spawned runner.

## Files

| File | What |
| --- | --- |
| `runtime.ts` | `createEngine` / `runOp`: lookup, zod input, gate, transaction (savepoints for nested ops), staged vault, output check, after-commit hooks. |
| `registry.ts` | `ALL_HANDLERS`: every op except `outreach.send` (unimplemented by contract). |
| `handlers/` | Lane B: roles.add/move/archive/get/list, pipeline.summary, companies.get, companies.dossier.write, apply.*, inbox.ingest, runs.*, config.*, vault.read. `shared.ts` `moveRole` is the one place lane B changes a status. |
| `lanes/` | Wiring for lanes E (`profile.ts`), F (`scoring.ts`, incl. `rebalance`), G (`freshness.ts`), H (`people.ts`, incl. outreach.get/list, contacts.get), I + A (`decisions.ts`: decisions.*, system.backends, system.doctor). |
| `decision-store.ts` | Lane I's `DecisionStore` over lane A repositories. |
| `policy.ts` | Hard-exclusion hint for the resolver (diff component + changed keys). |
| `rows.ts` | Thin helpers over lane A repositories. |
| `runner.ts` | Headless runner command lines + the spawn launcher. |
| `services.ts`, `vault.ts`, `ids.ts`, `dedupe.ts`, `errors.ts` | Injected services, staged vault + config, ids (lane A ULID), v1 dedupe mechanics, OpError. |

## runOp

1. Look up the op; `unimplemented` for `outreach.send`; zod-validate input; read `config.json`.
2. Optional async `prepare` (network only) outside the lock.
3. Top-level writes: `BEGIN IMMEDIATE` ... `COMMIT`, serialized per engine. An op run from inside another op (a decision's action, a rescore, the learn loop, `decisions.resolve`) runs in a `SAVEPOINT` of its parent and rolls back alone. Reads (`readOnly`) take no lock. Vault writes are staged and flush only after the outermost commit; after-commit hooks (runner launch) run after the lock is released.
4. Gate (wave1-decisions #17, #24):
   - Human-only ops (`apply.mark_submitted`) and hard exclusions (`isHardHuman`: submit, send, delete) from a non-human actor: a high-impact decision in Needs you, `requires_human`.
   - Static medium/high ops (`roles.move`, `roles.archive`, `outreach.to_gmail`, `config.update`) from an automated actor go through the resolver's `record` with `ctx.confidence` (`{ p, backend }`): the #24 grid decides (auto, auto + undo, or Needs you). No confidence = Needs you. The handler's `setUndo(...)` is stored as `action_json.undo` when the outcome is auto + undo.
   - A live decision whose `action_json.op` (or `.undo.op`) is this op authorizes it (`ctx.decisionId`).
   - `inbox.ingest` (`selfGated`) and dynamic-impact ops (`profile.apply_diff`, `roles.check_freshness`, `decisions.*`) apply policy per item through the resolver.
5. Output is validated against the contract; event types must be in the op's `emits`.

## Resolver per op call

Each call gets lane I's resolver over lane A's repos: rule -> Kev (`backends.default`) -> agent -> human. The `agent` backend is present only when `ctx.actor === 'agent'`; it never calls an API and answers only with what the agent supplied (`ctx.confidence` for a single yes/no question), otherwise it yields to a human. Jev and the Anthropic API adapter are registered only when `backends.jev.enabled` / `backends.llm.enabled` (and their keys) are set. Second opinion (`auto_second`): the attached agent, else a human. The resolver never runs actions itself; callers apply auto outcomes, and `decisions.resolve` / `decisions.undo` run `action_json` / `action_json.undo` through nested `runOp` (honoring `when`).

## Headless runner (`runs.start`)

A human or schedule `runs.start` commits the run as `queued`; the run queue (below) then launches `config.runner` with an MCP config pointing at the pp MCP server over stdio (`node packages/mcp/dist/bin.js`, `PP_HOME` set). The prompt (`skillPrompt`) = the run ids + the tools the run has + `skills/<skill>/SKILL.md` + its companion files (`SKILL_ASSETS`, e.g. scout's `plan.md`), read from the repo by absolute path (`resolveRepoRoot` walks up from the engine, source or `dist/`). Skill files live in the repo, never the vault: no skill looks for them with `vault.read`. An agent calling `runs.start` is already the session doing the work: nothing is launched. A runner that cannot start finishes the run as `error`. Output goes to `$TMPDIR/pp-runs/<run_id>.log`, never the vault.

**Per-skill tools (`SKILL_TOOLS`, #20).** Headless runs cannot answer a permission prompt, so each run pre-approves exactly what its skill needs and nothing broader (no shell, no file writes or reads; every read and write is an op):

| Skill | Tools | Why |
| --- | --- | --- |
| scout, research, freshness | pp + WebSearch + WebFetch | query boards and career pages; sourced dossier; judge live pages |
| tailor, score | pp + WebFetch | capture the full JD when only a title is on file |
| fill | pp + WebFetch | read the real portal questions (no browser in a headless run) |
| inbox, learn, onboard | pp | ops only |
| connect | pp (+ `--chrome`; Gmail draft step below) | unchanged |

**Fail loudly.** If the runner exits while the run is still `running`, `runs.start` finishes it as `error` with `summary_json.error` (and `denied_tools`, `runner_log`). For Claude Code the denied tools come from the result's `permission_denials`; the error names each tool and the fix (settings deny rule, or `SKILL_TOOLS` / `config.runner.args`). The prompt also tells the agent to finish with `summary.error: "tool denied: <tool>"` itself. Only observable while the launching process (`pp up`) is alive.

**Run queue (#30).** `runs.start` is the single entry point for skill runs. A human or schedule run is written `queued` (`summary_json.queued_at`), unless an active queue run already has the same skill and scope (role, contact, outreach; research: the company), in which case that run is returned with `deduped: true`. `runs.dispatch` (called after every `runs.start` and `runs.finish`, by `pp up` on start and every 30 s, and once by `pp drain`) marks the oldest queued runs `running` in one `BEGIN IMMEDIATE` transaction, up to `config.runs.max_concurrent` (default 2), skipping a run whose scope already has a running run, and launches them after commit (`started_at` = launch time, `summary_json.launched_at`). An agent's own run is `running` at once and is never queued, launched, deduped against or counted.

**Pipeline (#30, config `pipeline`, on by default).** `runs.finish` applies the rules and queues the next runs with `triggered_by` (+ `triggered_by_skill`); the finished run lists them in `summary_json.triggered`. `score_after_scout`: a scout run that ends `ok` with roles in the inbox queues one score run for the whole inbox (it may wait behind a running one, which listed the inbox before the new roles arrived). `research_after_score`: a score run that ends `ok` or `partial` queues one research run per company of a role it scored (its `role_scored` events) that is now neither `inbox` nor `archived` and whose company has no dossier.

**Interrupted runs (#21).** The spawn launcher writes `<os tmp>/pp-runs/<runId>.pid` next to the runner log (removed on exit). `pp up` calls `interruptStaleRuns` on startup and every 30 s: a `running` run that a launcher started (`summary_json.runner`, actor not `agent`), older than 60 s, whose pid is gone is finished through `runs.finish` as `error` with `summary_json.error: "interrupted"`. Agent-session runs, in-process runs and `queued` runs are left alone.

| Runner | Command line (flags checked 2026-10: `claude --help` 2.1.x, Codex config reference, Cursor CLI parameters + permissions docs) |
| --- | --- |
| `claude` | `claude -p <prompt> --mcp-config '<json>' --strict-mcp-config --tools <web tools or ""> --allowedTools mcp__pp[,WebSearch,WebFetch] --permission-mode dontAsk --permission-prompts none --output-format json`, cwd `PP_HOME`. `--tools` limits the built-ins (MCP tools stay), `--allowedTools` pre-approves, `dontAsk` + `--permission-prompts none` deny anything else. `connect`: `--strict-mcp-config --allowedTools mcp__pp ... --chrome` as before. |
| `codex` | `codex exec --skip-git-repo-check -c mcp_servers.pp.command=".." -c mcp_servers.pp.args=[..] -c mcp_servers.pp.env.PP_HOME=".." -c approval_policy="never" -c web_search="live"\|"disabled" <prompt>`, cwd `PP_HOME` (never a git repo). Codex has one web tool (`web_search`: disabled, cached, indexed, live); any web skill gets `live`, the rest `disabled`. No `--search` flag is documented for `exec`. |
| `cursor-agent` | `cursor-agent -p <prompt> --output-format text --trust --approve-mcps --force`, cwd = a temp dir holding `.cursor/mcp.json` (MCP servers) and `.cursor/cli.json` (`permissions`: allow `Mcp(pp:*)` + `WebFetch(*)` for web skills, deny `Shell(*)`, `Write(**)`; deny wins over `--force`). Cursor documents no web search tool or permission for the CLI; web skills rely on `WebFetch`. |

`config.runner.args` are appended. Tests use `fakeLauncher()`; nothing spawns in CI.

**Gmail draft step** (`runs.start { skill: 'connect', outreach_id }`, Gmail via agent): role and contact come from the outreach (must be `drafted`); `summary_json` gets `outreach_id` + `step: 'gmail_draft'`. The prompt (`gmailDraftPrompt`) tells the agent to read `outreach.get`, create a Gmail **draft** with its own Gmail tool (never send), then call `outreach.to_gmail { outreach_id, gmail_draft_id, confidence }` and `runs.finish`. `claude` drops `--strict-mcp-config` (so the claude.ai Gmail connector loads), allows `mcp__pp,mcp__claude_ai_Gmail__create_draft`, denies send / reply / forward / delete_draft, and skips `--chrome`. Codex and Cursor use the Gmail MCP server the user configured for them.
