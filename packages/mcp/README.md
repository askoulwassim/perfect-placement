# @perfect-placement/mcp

**Owner: lane C.** The MCP server for Perfect Placement. A thin adapter over the ops registry: no business logic lives here.

- **Tools:** one per op in `OPS` (`packages/contracts`), generated at startup. Name = op name (`roles.list`), description = op description plus policy notes derived from the op flags, input schema = `opInputJsonSchema(op)` (minus `$schema`), annotations from `readOnly` / `impact`, and `_meta["perfect-placement/op"]` carries `{ op, impact, dynamicImpact, humanOnly, unimplemented, readOnly, emits, owner }`. Nothing is hand-written per op.
- **Calls:** every tool call is `runOp(op, arguments, { actor: 'agent', now })`. The actor is always `agent`. The `OpOutcome` is returned in `structuredContent`:
  - `ok` -> `{ status: 'ok', output, eventIds }`
  - `requires_human` -> `{ status: 'requires_human', decisionId }` (not an error; the decision is in the Needs-you queue). High-impact and `humanOnly` ops (`apply.mark_submitted`, `outreach.send`, high `profile.apply_diff`) end here.
  - `error` -> `isError: true`, `{ status: 'error', code, message, issues? }`
- **Resources:** `pp://profile` (profile card), `pp://needs-you` (pending decisions), `pp://roles/{role_id}`, `pp://roles/{role_id}/contacts`, `pp://companies/{company_id}`. Each is one read-only op.
- **Transports:** stdio, and Streamable HTTP (stateless, JSON responses, loopback hosts only).

## API

```ts
import { createPpMcpServer, createMcpHttpHandler, serveStdio, startMcpHttpServer } from '@perfect-placement/mcp';

createPpMcpServer({ runOp, now?, toolNames? })  // McpServer, connect any transport
serveStdio({ runOp })                           // stdio
createMcpHttpHandler({ runOp })                 // (req, res) handler; `pp up` mounts it at /mcp
startMcpHttpServer({ runOp, port?, host? })     // standalone HTTP server
```

`@perfect-placement/mcp/testing` exports `createFakeRunOp()`: an in-memory **fake** runOp over the synthetic fixtures, for tests and demos only. Never wire it into `pp up`.

## Run

```
pnpm --filter @perfect-placement/mcp build
node packages/mcp/dist/bin.js --fixtures          # stdio, fake fixtures runOp (works today)
node packages/mcp/dist/bin.js                     # stdio, lane B runOp from @perfect-placement/engine (Wave 2)
node packages/mcp/dist/bin.js --http --port 7331  # http://127.0.0.1:7331/mcp
```

`--tool-names underscore` (or `PP_MCP_TOOL_NAMES=underscore`) exposes `roles_list` instead of `roles.list`, for any client that rejects dots in tool names. Claude Code normalizes names itself, so the default is fine there.

## Client config

Replace `/ABS/PATH` with the absolute path of your clone. Drop `--fixtures` once the engine runOp lands. These are snippets to paste; nothing here edits your config.

**Claude Code** (stdio):

```
claude mcp add perfect-placement -- node /ABS/PATH/packages/mcp/dist/bin.js --fixtures
```

or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "perfect-placement": { "command": "node", "args": ["/ABS/PATH/packages/mcp/dist/bin.js", "--fixtures"] }
  }
}
```

Over HTTP while `pp up` (or `--http`) is running:

```
claude mcp add --transport http perfect-placement http://127.0.0.1:7331/mcp
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.perfect-placement]
command = "node"
args = ["/ABS/PATH/packages/mcp/dist/bin.js", "--fixtures"]
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "perfect-placement": { "command": "node", "args": ["/ABS/PATH/packages/mcp/dist/bin.js", "--fixtures"] }
  }
}
```

Cursor over HTTP: `{ "mcpServers": { "perfect-placement": { "url": "http://127.0.0.1:7331/mcp" } } }`.

## Try it

In a fresh session with the server configured: call `roles.list` with `{ "status": ["inbox"] }`, then `roles.score` on one of those ids with nine 1 to 5 criteria and `facts: {}`, then read `pp://needs-you` or call `decisions.queue`. Calling `apply.mark_submitted` returns `requires_human` and the new decision shows up in the queue. The app never submits and never sends.

## Tests

`pnpm --filter @perfect-placement/mcp test`: tool generation (one per op, schemas equal `opInputJsonSchema`), a real MCP client over the in-memory transport (list roles, score a fixture role, queued decisions, `requires_human`, resources), and the Streamable HTTP transport (client round trip, host and method guards).
