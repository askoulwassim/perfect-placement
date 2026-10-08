# @perfect-placement/cli (`pp`)

**Owner: lane B**, except `src/commands/migrate.ts` and `src/commands/doctor.ts` (lane A). Thin: every command goes through the engine (`openEngine({ home, services })`; `Io.services` overrides the engine services, tests pass no-network fakes).

```
pp up      [--port 5177] [--web <dir>|none] [--fixtures] [--kev] [--tool-names dotted]
pp init                                       new vault + default config.json (refuses an existing or git-tracked dir)
pp doctor  [--json]                           system.doctor via the engine (never creates a vault)
pp migrate --from <v1 repo> [--dry-run] [--json]   lane A importer; refuses a PP_HOME inside a git repo
pp scout   --in candidates.json [--note ..]   runs.start -> roles.add -> runs.finish
pp score   --in scores.json                   roles.score (lane F)
pp fresh   [--role <id>]...                   roles.check_freshness (lane G)
pp inbox   --in messages.json                 inbox.ingest
pp op      <name> ['<json>' | --input <json> | --in f]   any op
```

Common flags: `--home <dir>` (else `PP_HOME`, else `~/.perfect-placement`), `--actor agent|human|schedule` (default `agent` for `pp op` and the skill commands), `--dry-run`. `--in -` reads stdin.

## `pp up`

One process on 127.0.0.1 (loopback bind and loopback `Host` header only):

| Route | What |
| --- | --- |
| `POST /api/ops/:name` | body = op input JSON; `runOp(name, input, { actor: 'human' })`; returns the `OpOutcome` (200 ok, 202 requires_human, 4xx/5xx by error code). Unknown op 404, bad JSON 400. |
| `GET /api/ops`, `GET /api/health` | op list, health |
| `POST /mcp` | MCP Streamable HTTP, actor `agent`, same engine |
| `GET /*` | `apps/web/dist` (or `--web <dir>`) with SPA fallback |

Default port 5177 (the Vite dev server uses 5178 and may call the API cross-origin; loopback origins get CORS). `--fixtures` serves the real engine on a temp copy of the synthetic fixture vault (offline: no network, LinkedIn dry-run, no runner spawn; the temp dir is left in the OS temp dir). `--kev` only reports whether Kev answers at `config.backends.kev.baseUrl`; it never starts Kev. SIGINT / SIGTERM close the server and then the engine.

```
pnpm build
node packages/cli/dist/index.js up --fixtures            # http://127.0.0.1:5177
```

`pp scout|score|fresh|inbox` wrap their ops in a run (`runs.start` -> ops -> `runs.finish`) with actor `agent`, so no headless runner is launched (the caller is the session doing the work). A human or schedule `runs.start` (UI button, `pp op runs.start --actor human`) launches `config.runner`.
