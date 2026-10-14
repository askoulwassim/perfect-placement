# packages/engine/ops

The integration point: `runOp(name, input, ctx)` is the only way anything writes `pp.db` or the vault, and every op in the registry has a handler here (lanes A, B, E, F, G, H, I).

## Engine factory (what surfaces call)

```ts
import { openEngine } from '@perfect-placement/engine';
const engine = openEngine({ home?: string, services?: EngineServices }); // creates the vault + applies migrations
const outcome = await engine.runOp('roles.list', { status: ['active'] }, { actor: 'agent', now: () => new Date() });
// outcome: { status: 'ok', output, eventIds } | { status: 'requires_human', decisionId } | { status: 'error', code, message, issues? }
engine.close();
```

`engine.runOp` has the contract `RunOp` signature, so it plugs straight into the MCP server and `pp up` (`POST /api/ops/:name`). One engine per vault per process; top-level writes are serialized on its connection.

`EngineServices` (all optional; production defaults are the real ones): `fetch` (freshness ladder), `backends` (resolver backend overrides), `env` (KEV_API_KEY, ANTHROPIC_API_KEY), `profileLlm` (writing model for profile.learn; absent = the learn skill drafts), `linkedin`, `gmail`, `gmailContacts`, `outreachWriter`, `mx` (domain mail check for `people.find_email`: DNS MX, else an A record, #99; tests fake it), `emailProvider` (pinned finder seam, absent), `launcher` (headless runner), `freshnessDelayMs`, `sleep`. Tests use `@perfect-placement/engine/testing` (`openFixtureEngine`, `fakeBackend`, `fakeLauncher`, `noNetwork`): never the network, DNS, Kev, LinkedIn, Gmail or a spawned runner.

## Files

| File | What |
| --- | --- |
| `runtime.ts` | `createEngine` / `runOp`: lookup, zod input, gate, transaction (savepoints for nested ops), staged vault, output check, after-commit hooks. |
| `registry.ts` | `ALL_HANDLERS`: every op except `outreach.send` (unimplemented by contract). |
| `handlers/` | Lane B: roles.add (intake check via `scout/`)/move/archive/get/list, scout.watchlist_scan, pipeline.summary, companies.get, companies.dossier.write, apply.*, inbox.ingest, runs.*, config.*, vault.read. `shared.ts` `moveRole` is the one place lane B changes a status. |
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

Each call gets lane I's resolver over lane A's repos: rule -> Kev (`backends.default`) -> agent -> human. The `agent` backend is present only when `ctx.actor === 'agent'`; it never calls an API and answers only with what the agent supplied (`ctx.confidence` for a single yes/no question), otherwise it yields to a human. The Anthropic API adapter is registered only when `backends.llm.enabled` (and `ANTHROPIC_API_KEY`) are set. Second opinion (`auto_second`): the attached agent, else a human. The resolver never runs actions itself; callers apply auto outcomes, and `decisions.resolve` / `decisions.undo` run `action_json` / `action_json.undo` through nested `runOp` (honoring `when`).

## Headless runner (`runs.start`)

A human or schedule `runs.start` commits the run as `queued`; the run queue (below) then launches `config.runner` with an MCP config pointing at the pp MCP server over stdio (`node packages/mcp/dist/bin.js`, `PP_HOME` and `PP_RUN_ID` set). The prompt (`skillPrompt`) = the run ids + the tools the run has + `skills/<skill>/SKILL.md` + its companion files (`SKILL_ASSETS`, e.g. scout's `plan.md`), read from the repo by absolute path (`resolveRepoRoot` walks up from the engine, source or `dist/`). Skill files live in the repo, never the vault: no skill looks for them with `vault.read`. An agent calling `runs.start` is already the session doing the work: nothing is launched. A runner that cannot start finishes the run as `error`. Output goes to `$TMPDIR/pp-runs/<run_id>.log`, never the vault.

**Per-skill tools (`SKILL_TOOLS`, #20).** Headless runs cannot answer a permission prompt, so each run pre-approves exactly what its skill needs and nothing broader (no shell, no file writes or reads; every read and write is an op):

| Skill | Tools | Why |
| --- | --- | --- |
| scout, research, freshness | pp + WebSearch + WebFetch | query boards and career pages; sourced dossier; judge live pages |
| tailor, score | pp + WebFetch | capture the full JD when only a title is on file |
| fill | pp + WebFetch + Claude in Chrome read tools; with assist (#106) also `form_input` + `file_upload` | read the real portal questions; with assist upload the rendered PDFs (`apply.render_documents`) and fill the answer fields, stop before Submit, report `apply.fill_done` |
| inbox | pp + Gmail `search_threads`, `get_thread`, `get_message` | classify replies, read-only (#80) |
| learn, onboard | pp | ops only |
| connect | pp + Gmail `search_threads`, `get_thread`, `get_message`, `create_draft` (+ `--chrome`) | contact emails (#37); the run finishes its own Gmail drafts (#79) |

**Gmail (claude.ai connector, `mcp__claude_ai_Gmail__*`).** A skill with Gmail tools (`inbox`, `connect`, and the Gmail draft step) runs without `--strict-mcp-config` so the connector loads, pre-approves only its Gmail tools (`SKILL_TOOLS[skill].gmail`) and passes every other Gmail write in `GMAIL_WRITE_TOOLS` (send, reply, forward, draft create / update / delete, trash, spam, labels) to `--disallowedTools` (`gmailDeniedTools`). `inbox` is read-only: all writes denied, built-ins still narrowed (`--tools ""`, `dontAsk`). Each `skills/<skill>/SKILL.md` declares its tools in a `## Tools` section; `runner.test.ts` fails when that list and `skillAllowedTools` drift, when a SKILL.md names a Gmail tool its skill is not granted, or when a read-only skill is granted a write.

**Fail loudly.** If the runner exits while the run is still `running`, `runs.start` finishes it as `error` with `summary_json.error` (and `denied_tools`, `runner_log`). For Claude Code the denied tools come from the result's `permission_denials`; the error names each tool and the fix (settings deny rule, or `SKILL_TOOLS` / `config.runner.args`). The prompt also tells the agent to finish with `summary.error: "tool denied: <tool>"` itself. Only observable while the launching process (`pp up`) is alive.

For Codex, the runner translates the shared skill text's `WebSearch` and `WebFetch` names to the built-in web tool's search and open actions. This applies to the tool list, inlined skill and companion files, so a scoring run uses page retrieval instead of looking for a separate Claude `WebFetch` tool. Fetch-only skills still prohibit search queries, and skills without web access keep it disabled. An actual missing tool or denied call still ends the run; shell and connector fallbacks remain prohibited. See [Codex web search](https://learn.chatgpt.com/docs/web-search?surface=cli).

**Run queue (#30).** `runs.start` is the single entry point for skill runs. A human or schedule run is written `queued` (`summary_json.queued_at`), unless an active queue run already has the same skill and scope (role, contact, outreach; research: the company), in which case that run is returned with `deduped: true`. `runs.dispatch` (called after every `runs.start` and `runs.finish`, by `pp up` on start and every 30 s, and once by `pp drain`) marks the oldest queued runs `running` in one `BEGIN IMMEDIATE` transaction, up to `config.runs.max_concurrent` (default 2), skipping a run whose scope already has a running run, and launches them after commit (`started_at` = launch time, `summary_json.launched_at`). An agent's own run is `running` at once and is never queued, launched, deduped against or counted.

**Pipeline (#30, config `pipeline`, on by default).** `runs.finish` applies the rules and queues the next runs with `triggered_by` (+ `triggered_by_skill`); the finished run lists them in `summary_json.triggered`. `score_after_scout`: a scout run that ends `ok` with roles in the inbox queues one score run for the whole inbox (it may wait behind a running one, which listed the inbox before the new roles arrived). `research_after_score`: a score run that ends `ok` or `partial` queues one research run per company of a role it scored that is now neither `inbox` nor `archived` and whose company has no dossier. "Scored by the run" = its `role_scored` events linked to it (`payload_json.run_id`, below); only an agent's own run with no linked events falls back to unlinked events since it started.

**Ops linked to their run (#50).** The runner passes `PP_RUN_ID` into the pp MCP server's env; the server sets `ctx.runId` on every op it runs. With `ctx.runId`, every event an op emits records `payload_json.run_id` (unless the payload names one), and run logs append to that run.

**Schedules (#29).** `runs.start { skill, schedule }` (schedule key, its skill per `SCHEDULE_SKILL`: `scout_score` = scout) keeps `summary_json.schedule`. `schedules.status` returns, per schedule, the spec, the next local fire time, the last run with that `schedule`, and the OS job state from `EngineServices.scheduleJobs` (`unknown` without one). `config.update` that changes `schedules` calls `scheduleJobs.sync` after commit (`pp up` and `pp op` wire the CLI's launchd / systemd manager in; the web Settings toggles go through this). `catchUpSchedules` (called by `pp up` on start) queues once each schedule that is on, ran before, is not active, and fired since its last run started.

**Interrupted runs (#21).** The spawn launcher writes `<os tmp>/pp-runs/<runId>.pid` next to the runner log (removed on exit). `pp up` calls `interruptStaleRuns` on startup and every 30 s: a `running` run that a launcher started (`summary_json.runner`, actor not `agent`), older than 60 s, whose pid is gone is finished through `runs.finish` as `error` with `summary_json.error: "interrupted"`. Agent-session runs, in-process runs and `queued` runs are left alone.

| Runner | Command line (flags checked 2026-10: `claude --help` 2.1.x, Codex config reference, Cursor CLI parameters + permissions docs) |
| --- | --- |
| `claude` | `claude -p <prompt> --mcp-config '<json>' --strict-mcp-config --tools <web tools or ""> --allowedTools mcp__pp[,WebSearch,WebFetch] --permission-mode dontAsk --permission-prompts none --output-format json`, cwd `PP_HOME`. `--tools` limits the built-ins (MCP tools stay), `--allowedTools` pre-approves, `dontAsk` + `--permission-prompts none` deny anything else. `connect`: `--strict-mcp-config --allowedTools mcp__pp ... --chrome` as before. Fill assist (#123): `runs.dispatch` renders the PDFs first (`apply.render_documents`, logged on the run) and adds `--add-dir <absolute PP_HOME>/files/<role_id>` (that folder only, never PP_HOME or `files/`) so Claude in Chrome's `file_upload` can read them; the prompt's Uploads line names their absolute paths. A failed render launches without `--add-dir`, and the prompt says to upload nothing and report both documents as skipped with the reason. |
| `codex` | `codex exec --skip-git-repo-check -c mcp_servers.pp.command=".." -c mcp_servers.pp.args=[..] -c mcp_servers.pp.env.PP_HOME=".." -c mcp_servers.pp.env.PP_RUN_ID=".." -c approval_policy="never" -c web_search="live"\|"disabled" <prompt>`, cwd `PP_HOME` (never a git repo). Codex has one web tool (`web_search`: disabled, cached, indexed, live); any web skill gets `live`, the rest `disabled`. No `--search` flag is documented for `exec`. No Claude in Chrome, so no fill assist upload: no folder is added (Codex's `--add-dir` adds writable sandbox roots, broader than a read). |
| `cursor-agent` | `cursor-agent -p <prompt> --output-format text --trust --approve-mcps --force`, cwd = a temp dir holding `.cursor/mcp.json` (MCP servers) and `.cursor/cli.json` (`permissions`: allow `Mcp(pp:*)` + `WebFetch(*)` for web skills, deny `Shell(*)`, `Write(**)`; deny wins over `--force`). Cursor documents no web search tool or permission for the CLI; web skills rely on `WebFetch`. No Claude in Chrome and no documented extra-directory flag, so no fill assist upload. |

`config.runner.args` are appended. Tests use `fakeLauncher()`; nothing spawns in CI.

## Ask agent session (`ask.ts`, #39)

`pp up`'s `POST /api/ask` runs one conversational turn of `config.runner` per message (`runAsk`), with the pp MCP server (`PP_ASK=1`: `runs.start` defaults to `queue: true`, so skill work becomes a queued headless run, actor `ask`) and the system prompt `askAgentPrompt()` (act through ops, the policy, never submit or send, reply in OpenUI Lang with the genui cards; `ASK_CARD_SIGNATURES` is checked against the web library by a test). Tools: pp MCP + web search / fetch; no shell, no file reads or writes. Output is normalized by `AskStreamParser` into `AskChatEvent`s (`thread`, `text`, `tool`, `tool_result`, `run`, `error`, `done`).

| Runner | Ask turn |
| --- | --- |
| `claude` | `claude -p <message> --append-system-prompt <prompt> --mcp-config '<json>' --strict-mcp-config --tools WebSearch,WebFetch --allowedTools mcp__pp,WebSearch,WebFetch --permission-mode dontAsk --permission-prompts none --output-format stream-json --verbose --include-partial-messages [--resume <session_id>]`, cwd `PP_HOME` (sessions are per directory). Text streams token by token. |
| `codex` | `codex exec --json --skip-git-repo-check -c mcp_servers.pp.* -c approval_policy="never" -c sandbox_mode="read-only" -c web_search="live" <prompt>`; no resume here: the prompt replays the last turns (`replayPrompt`). Text arrives per agent message, not per token. |
| `cursor-agent` | `cursor-agent -p <prompt> --output-format stream-json --trust --approve-mcps --force` in a temp dir with `.cursor/mcp.json` + `.cursor/cli.json` (allow `Mcp(pp:*)`, `WebFetch(*)`; deny `Shell(*)`, `Write(**)`); transcript replay as Codex. Tool call shapes are parsed best effort. |

Threads (`AskThreads`) live in memory and, in `pp up`, in the vault's `ask_thread` table (migration 008, `dbAskThreadStore` in the db layer, #69): runner, Claude session id and the last 20 turns, so a restart resumes a thread by `thread_id`; threads idle for 30 days are pruned. Errors: the runner not on PATH -> `runner_missing`; a login / API key failure -> `not_logged_in`; anything else -> `runner_failed`. The launcher is injected (`AskLauncher`; default `createAskSpawner`, attached, killed when the request closes); tests use `fakeAskLauncher` with recorded transcripts (`@perfect-placement/engine/testing`).

**Gmail draft step** (`runs.start { skill: 'connect', outreach_id }`, Gmail via agent): role and contact come from the outreach (must be `drafted`); `summary_json` gets `outreach_id` + `step: 'gmail_draft'`. The prompt (`gmailDraftPrompt`) tells the agent to read `outreach.get`, create a Gmail **draft** with its own Gmail tool (never send), then call `outreach.to_gmail { outreach_id, gmail_draft_id, confidence }` and `runs.finish`. `claude` drops `--strict-mcp-config` (so the claude.ai Gmail connector loads), allows `mcp__pp,mcp__claude_ai_Gmail__create_draft`, denies every other Gmail write (`GMAIL_DENIED_TOOLS`), and skips `--chrome`. A full `connect` run (#82) gets `--chrome` (only when `config.linkedin.mode` is `live`), pre-approves the Chrome read and navigate tools (`CHROME_READ_TOOLS`), denies every acting Chrome tool (`CHROME_WRITE_TOOLS`), Bash / Write / Edit and every Gmail write but `create_draft` (`connectDeniedTools`), runs `dontAsk`, and its prompt states the LinkedIn caps and today's profile budget (`linkedinLine`). #99: the step is refused while the recipient's address is a guess waiting in Needs you; confirming it queues the step. An `in_gmail` draft with no To (`gmail_to` null) gets the **To update step** instead (`step: 'gmail_to'`, `gmailToPrompt`): `claude` allows only `mcp__pp`, Gmail `get_draft` and `update_draft` and denies every other Gmail write (`GMAIL_TO_DENIED_TOOLS`, `create_draft` included). A full `connect` run is granted `create_draft` too (#79), so it finishes its drafts without queuing this step; the step stays for the UI's **Create Gmail draft** on a saved or edited draft. Codex and Cursor use the Gmail MCP server the user configured for them.

**Connector retry** (#122): a claude.ai connector (Gmail) or Claude in Chrome tool the skill is granted but the session did not load is reported as `runs.finish { status: "error", error_code: "connector_unavailable" }`. `runs.finish` re-queues a queue run once (`runs.start { ..., retry_of }`, `summary_json.attempt` 2, `not_before` = now + `CONNECTOR_RETRY_DELAY_MS`, 45 s): the dispatcher skips it until then and `EngineServices.timer` dispatches it when due. The failed run keeps `error` with `retried: <id>`. A second failure, any other error, and a connect run whose Gmail draft exists (`gmail_draft_id`) or waits in Needs you are not retried. Policy lives in `retry.ts` (shared with scheduled-run retries, #121).

**Scheduled runs** (#121): a run started by a schedule, or chained or retried from one (`summary_json.schedule`, else `schedule_origin`), gets `SCHEDULE_RETRY` instead: any transient failure (`error_code` `connector_unavailable` or `stalled`, or error text with idle timeout, ECONNRESET, ETIMEDOUT, stalled; a runner that exits without `runs.finish` gets the marker it printed, e.g. `(ECONNRESET)`) is re-queued after 1, 5, then 15 min, up to 3 retries (4 tries), each linked by `retry_of` + `attempt`. One policy per run (`retryPolicyFor`): never both the 45 s connector retry and the schedule backoff. `capStalledRuns` (in `pp up`'s sweep and `pp run`'s drain) kills the runner's process group of a scheduled run still `running` past its skill's cap (`STALL_LIMIT_MS`, from `launched_at`: inbox 10 min, freshness 20, scout 15, score 15, research, connect, fill, voice, tailor 10) and finishes it `error_code: "stalled"`, so it is retried. Spent retries leave the run `error`; `pp up`'s catch-up queues the schedule again (`failedForGood`), and `system.doctor` reports the last failure per schedule (`scheduled_failures`, informational).
