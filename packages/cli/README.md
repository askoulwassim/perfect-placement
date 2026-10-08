# @perfect-placement/cli (`pp`)

**Owner: lane B**, except `src/commands/migrate.ts` and `src/commands/doctor.ts` (lane A; `pp` calls their `run(argv, io)` once exported, and `pp doctor` falls back to the `system.doctor` op). Thin: every command calls ops.

```
pp up      [--port 4317] [--web <dir>]      API at /api/ops (+ /mcp, web) on 127.0.0.1
pp scout   --in candidates.json [--note ..]  runs.start -> roles.add -> runs.finish
pp score   --in scores.json                  roles.score (lane F)
pp fresh   [--role <id>]...                  roles.check_freshness (lane G)
pp inbox   --in messages.json                inbox.ingest
pp op      <name> [--input <json>|--in f]    any op
pp doctor | pp migrate --from <v1 repo>      lane A
```

Common flags: `--home <dir>` (else `PP_HOME`, else `~/.perfect-placement`), `--actor agent|human|schedule` (default `agent`), `--dry-run`. `--in -` reads stdin. The HTTP API defaults `actor` to `human` (the UI); MCP clients must send `agent`.
