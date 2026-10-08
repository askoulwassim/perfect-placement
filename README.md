# Perfect Placement

A local, agent-first job-search system: scout, score, keep fresh, tailor, connect, watch the inbox, learn. The repo is the system only; your data lives in a local vault (`~/.perfect-placement`, override with `PP_HOME`) and is never committed.

Status: **Wave 2 integrated** (engine, decision layer, MCP, web UI on live ops). Real-data cutover runs with the owner present (`docs/v2/wave2-plan.md`). See `AGENTS.md` for how agents work here.

```
corepack enable
pnpm i
pnpm build && pnpm test
node packages/cli/dist/index.js up --fixtures   # demo at http://127.0.0.1:5177
```

Requires Node 22+.
