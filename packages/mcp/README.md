# @perfect-placement/mcp

The MCP server for Perfect Placement, on the real engine (`openEngine()` from `@perfect-placement/engine`). A thin adapter over the ops registry: no business logic lives here.

- **Tools:** one per op in `OPS` (`packages/contracts`), generated at startup. Name = op name with dots as underscores (`roles.list` -> `roles_list`, see "Tool names"); `title` and `_meta["perfect-placement/op"].op` keep the dotted op name. Description = op description plus policy notes from the op flags; input schema = `opInputJsonSchema(op)` (minus `$schema`); annotations from `readOnly` / `impact`; `_meta["perfect-placement/op"]` = `{ op, impact, dynamicImpact, humanOnly, unimplemented, readOnly, emits, owner }`. Nothing is hand-written per op.
- **Confidence:** every writing tool (not `readOnly`) takes an optional `confidence` number (0 to 1). It is stripped from the op input and passed as `ctx.confidence = { p, backend: 'agent' }`, so medium-impact calls (`roles.move`, `roles.archive`, ...) go through the policy grid (wave1-decisions #17, #24). Without it they wait in Needs you.
- **Calls:** every tool call is `runOp(op, input, { actor: 'agent', now, confidence? })`. The `OpOutcome` is returned in `structuredContent`:
  - `ok` -> `{ status: 'ok', output, eventIds }`
  - `requires_human` -> `{ status: 'requires_human', decisionId }` (not an error; the decision is in the Needs-you queue). Human-only and hard-excluded ops (`apply.mark_submitted`, send, delete, dealbreaker / comp floor diffs) end here for an agent.
  - `error` -> `isError: true`, `{ status: 'error', code, message, issues? }`
- **Resources:** `pp://profile` (profile.get), `pp://needs-you` (decisions.queue), `pp://roles/{role_id}` (roles.get), `pp://roles/{role_id}/contacts`, `pp://companies/{company_id}` (companies.get). Each is one read-only op.
- **Transports:** stdio, and Streamable HTTP (stateless, JSON responses, loopback hosts only). `pp up` mounts the HTTP handler at `/mcp` on its own port.

## API

```ts
import { createPpMcpServer, createMcpHttpHandler, openFixtureDemo, serveStdio, startMcpHttpServer } from '@perfect-placement/mcp';

createPpMcpServer({ runOp, now?, toolNames? })  // McpServer, connect any transport
serveStdio({ runOp })                           // stdio
createMcpHttpHandler({ runOp })                 // (req, res) handler; `pp up` mounts it at /mcp
startMcpHttpServer({ runOp, port?, host? })     // standalone HTTP server
openFixtureDemo()                               // real engine on a temp copy of the synthetic fixture vault (offline)
```

## Run

```
pnpm build
node packages/mcp/dist/bin.js                        # stdio, real engine on PP_HOME (default ~/.perfect-placement)
node packages/mcp/dist/bin.js --home /path/to/vault  # stdio, explicit vault
node packages/mcp/dist/bin.js --fixtures             # stdio demo: real engine on a temp copy of the synthetic fixtures
node packages/mcp/dist/bin.js --http --port 7331     # http://127.0.0.1:7331/mcp
pp up                                                # API + MCP at http://127.0.0.1:5177/mcp + web, one process
```

The fixtures demo is offline: no network fetches, LinkedIn in `dry-run` (set with `config.update`), no headless runner spawned. The temp vault is left in the OS temp dir (surfaces never delete files; see the engine guard test). Kev is used only if one is already running at its configured loopback URL.

## Tool names

Default `underscore` (`roles_list`). `--tool-names dotted` (or `PP_MCP_TOOL_NAMES=dotted`) exposes raw op names (`roles.list`).

Dots are valid MCP tool names (spec SEP-986 allows `A-Z a-z 0-9 _ - .`), but each client checked (2026-10) rewrites or flags them:

| Client | Dotted `roles.list` | Evidence |
| --- | --- | --- |
| Claude Code | rewritten to `mcp__pp__roles_list` | MCP docs: characters outside `[A-Za-z0-9_-]` are replaced with `_` |
| Codex | rewritten to `roles_list` | Codex sanitizes MCP tool names to the Responses API pattern `^[a-zA-Z0-9_-]+$` (codex PR #8694) |
| Cursor | warns "will be filtered", rewrites `.` to `_` | Cursor forum bug, confirmed by staff Apr 2026, no fix date |

Underscore names are what all three already show the model, are stable across clients, and avoid Cursor's warning. Op names stay dotted everywhere else (registry, `runOp`, `/api/ops/:name`, skills, `title`). Cursor caps server + tool name at 60 characters: with the server key `pp` the longest tool (`companies_dossier_write`) is 25. Tests: `tools.test.ts` (names match `[a-zA-Z0-9_-]{1,64}`, map back without collisions, fit Cursor's limit), `server.test.ts` (default underscore, dotted opt-in).

## Client config

`pp setup` writes these for you (asks first, backs up the file, keeps other servers). Snippets to paste by hand: Replace `/ABS/PATH` with the absolute path of your clone and `/ABS/VAULT` with your PP_HOME. The server key is `pp`, matching the headless runner (`mcp__pp__*` in Claude Code). Add `--fixtures` to `args` to try the synthetic demo first.

**Claude Code** (verified against code.claude.com/docs/en/mcp):

```
claude mcp add --transport stdio --env PP_HOME=/ABS/VAULT pp -- node /ABS/PATH/packages/mcp/dist/bin.js
claude mcp add --transport http pp http://127.0.0.1:5177/mcp          # while `pp up` runs
```

Project `.mcp.json` (HTTP entries need `"type": "http"`):

```json
{
  "mcpServers": {
    "pp": { "command": "node", "args": ["/ABS/PATH/packages/mcp/dist/bin.js"], "env": { "PP_HOME": "/ABS/VAULT" } }
  }
}
```

```json
{ "mcpServers": { "pp": { "type": "http", "url": "http://127.0.0.1:5177/mcp" } } }
```

**Codex** (`~/.codex/config.toml`, verified against the Codex MCP docs):

```toml
[mcp_servers.pp]
command = "node"
args = ["/ABS/PATH/packages/mcp/dist/bin.js"]
env = { PP_HOME = "/ABS/VAULT" }
```

```toml
[mcp_servers.pp]
url = "http://127.0.0.1:5177/mcp"
```

CLI equivalents: `codex mcp add pp --env PP_HOME=/ABS/VAULT -- node /ABS/PATH/packages/mcp/dist/bin.js` and `codex mcp add pp --url http://127.0.0.1:5177/mcp`.

**Cursor** (`.cursor/mcp.json` in a project or `~/.cursor/mcp.json`, verified against cursor.com/docs/context/mcp):

```json
{
  "mcpServers": {
    "pp": { "command": "node", "args": ["/ABS/PATH/packages/mcp/dist/bin.js"], "env": { "PP_HOME": "/ABS/VAULT" } }
  }
}
```

```json
{ "mcpServers": { "pp": { "url": "http://127.0.0.1:5177/mcp" } } }
```

## Try it

In a fresh session with the server configured (`--fixtures` for the demo): call `roles_list` with `{ "status": ["inbox"] }`, then `roles_score` on one of those ids with nine 1 to 5 criteria and `facts: {}`, then read `pp://needs-you` or call `decisions_queue`. `roles_move` without `confidence` returns `requires_human`; with `confidence: 0.95` it applies (auto). `apply_mark_submitted` returns `requires_human` and the new decision shows up in the queue. The app never submits and never sends.

## Tests

`pnpm --filter @perfect-placement/mcp test`: tool generation (one per op, schemas equal `opInputJsonSchema` plus `confidence`, naming), a real MCP client over the in-memory transport on the real engine with a temp fixtures vault (list, score, confidence -> policy grid, queued decisions, `requires_human`, resources), the Streamable HTTP transport (round trip, host and method guards), and the fixtures demo engine. No network, Kev or runner spawn.
