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

A human or schedule `runs.start` commits the run, then launches `config.runner` with the prompt = the run ids + `skills/<skill>/SKILL.md`, and an MCP config pointing at the pp MCP server over stdio (`node packages/mcp/dist/bin.js`, `PP_HOME` set). An agent calling `runs.start` is already the session doing the work: nothing is launched. A runner that cannot start finishes the run as `error`. Output goes to `$TMPDIR/pp-runs/<run_id>.log`, never the vault.

| Runner | Command line (flags checked against each CLI's docs, 2026-10) |
| --- | --- |
| `claude` | `claude -p <prompt> --mcp-config '<json>' --strict-mcp-config --allowedTools mcp__pp --permission-prompts none --output-format json` (+ `--chrome` for `connect`, LinkedIn via Claude in Chrome), cwd `PP_HOME` |
| `codex` | `codex exec --skip-git-repo-check -c mcp_servers.pp.command=".." -c mcp_servers.pp.args=[..] -c mcp_servers.pp.env.PP_HOME=".." -c approval_policy="never" <prompt>`, cwd `PP_HOME` (never a git repo) |
| `cursor-agent` | `cursor-agent -p <prompt> --output-format text --approve-mcps --force`, cwd = a temp dir holding `.cursor/mcp.json` (Cursor reads project MCP config) |

`config.runner.args` are appended. Tests use `fakeLauncher()`; nothing spawns in CI.

**Gmail draft step** (`runs.start { skill: 'connect', outreach_id }`, Gmail via agent): role and contact come from the outreach (must be `drafted`); `summary_json` gets `outreach_id` + `step: 'gmail_draft'`. The prompt (`gmailDraftPrompt`) tells the agent to read `outreach.get`, create a Gmail **draft** with its own Gmail tool (never send), then call `outreach.to_gmail { outreach_id, gmail_draft_id, confidence }` and `runs.finish`. `claude` drops `--strict-mcp-config` (so the claude.ai Gmail connector loads), allows `mcp__pp,mcp__claude_ai_Gmail__create_draft`, denies send / reply / forward / delete_draft, and skips `--chrome`. Codex and Cursor use the Gmail MCP server the user configured for them.
