# Perfect Placement

A local, agent-first job-search system: scout, score, keep fresh, tailor, connect, watch the inbox, learn. The repo is the system only; your data lives in a local vault (`~/.perfect-placement`, override with `PP_HOME`) and is never committed.

Status: **Wave 0** (contracts, fixtures, skeletons). See `docs/v2/README.md` for the build plan and `AGENTS.md` for how agents work here.

```
corepack enable
pnpm i
pnpm build && pnpm test
```

Requires Node 22+.
