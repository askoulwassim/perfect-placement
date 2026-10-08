# Lane C: MCP server

**Branch / worktree:** `v2/lane-c`  
**Owns (writes only here):** packages/mcp/**  
**Starts after:** Wave 0 merged  
**Inputs:** packages/contracts ops (zod), stubs from lane B

## Build

- Generate MCP tools from the ops registry (name, description, JSON Schema from zod). One tool per op; group names `profile.*`, `roles.*`, `apply.*`, `people.*`, `outreach.*`, `decisions.*`, `runs.*`, `system.*`.
- Resources: profile card, role, company, contacts for a role, the Needs-you queue.
- Transports: stdio (Claude Code, Codex, Cursor) and Streamable HTTP (served by `pp up`).
- High-impact ops are exposed but always return `requires_human` with the queued decision id.
- Config snippets in packages/mcp/README.md for Claude Code, Codex, Cursor.

## Done when

- A fresh Claude Code session with the MCP configured can list roles, score a fixture role, and see a queued decision.
- Tool list is generated, never hand-written.

## Never

- No business logic in the MCP layer.
- Never commit personal data. Never edit `packages/contracts` directly: add a request to `CONTRACT_CHANGES.md`.
- Never submit an application or send an email.
