# @perfect-placement/cli (`pp`)

**Owner: lane B**, except `src/commands/doctor.ts` (lane A). Thin: every command goes through the engine (`openEngine({ home, services })`; `Io.services` overrides the engine services, tests pass no-network fakes).

```
pp setup   [--yes] [--no-kev|--kev] [--model m] [--no-mcp|--mcp claude-code,codex,cursor,claude-desktop] [--no-schedules]
pp kev     install [--model m] [--yes] | start [--model m] [--wait [--timeout s]] | stop | status
pp up      [--port 5177] [--web <dir>|none] [--fixtures] [--no-kev] [--kev] [--tool-names dotted] [--no-catch-up]
pp init                                       new vault + default config.json (refuses an existing or git-tracked dir)
pp doctor  [--json]                           system.doctor via the engine (never creates a vault)
pp scout   --in candidates.json [--note ..]   runs.start -> roles.add -> runs.finish
pp score   --in scores.json                   roles.score (lane F)
pp fresh   [--role <id>]...                   roles.check_freshness (lane G)
pp inbox   --in messages.json                 inbox.ingest
pp drain                                      launch queued runs once
pp run     <skill> [--schedule] [--role <id>] [--no-wait]  queue a run, drain until it and what it triggers finish
pp schedules install|remove|status [--json]   OS jobs for config.schedules
pp op      <name> ['<json>' | --input <json> | --in f]   any op
```

Common flags: `--home <dir>` (else `PP_HOME`, else `~/.perfect-placement`), `--actor agent|human|schedule` (default `agent` for `pp op` and the skill commands), `--dry-run`. `--in -` reads stdin.

## `pp up`

One process on 127.0.0.1 (loopback bind and loopback `Host` header only):

| Route | What |
| --- | --- |
| `POST /api/ops/:name` | body = op input JSON; `runOp(name, input, { actor: 'human' })`; returns the `OpOutcome` (200 ok, 202 requires_human, 4xx/5xx by error code). Unknown op 404, bad JSON 400. |
| `GET /api/ops`, `GET /api/health` | op list, health |
| `POST /api/ask` | Ask (#39): body `AskChatRequest` `{ thread_id?, message, context?: { screen?, role_id? } }`; reply `text/event-stream` of `AskChatEvent`s (`thread` first, then `text` / `tool` / `tool_result` / `run`, then `done` or `error`). One turn of `config.runner` with the pp MCP server; the runner is killed if the client disconnects. See `packages/engine/ops/README.md`, "Ask agent session". |
| `POST /mcp` | MCP Streamable HTTP, actor `agent`, same engine |
| `GET /*` | `apps/web/dist` (or `--web <dir>`) with SPA fallback |

Default port 5177 (the Vite dev server uses 5178 and may call the API cross-origin; loopback origins get CORS). `--fixtures` serves the real engine on a temp copy of the synthetic fixture vault (offline: no network, LinkedIn dry-run, no runner spawn; the temp dir is left in the OS temp dir). `--kev` reports whether Kev answers at `config.backends.kev.baseUrl`. If Kev was installed with `pp kev install` and is not answering, `pp up` starts it and stops it on exit (only what it started); `--no-kev` skips that. SIGINT / SIGTERM close the server and then the engine.

```
pnpm build
node packages/cli/dist/index.js up --fixtures            # http://127.0.0.1:5177
```

`pp scout|score|fresh|inbox` wrap their ops in a run (`runs.start` -> ops -> `runs.finish`) with actor `agent`, so no headless runner is launched (the caller is the session doing the work). A human or schedule `runs.start` (UI button, `pp op runs.start --actor human`) launches `config.runner`.

## `pp setup` and `pp kev`

`src/commands/setup.ts`, `src/commands/kev.ts`; machine access in `src/system/` (`SystemDeps`: platform, PATH lookup, spawn, fetch, clock), the only cli code allowed to write files (agent client configs with `.bak-<timestamp>` backups, and Kev runtime files in `$PP_HOME/kev/`; see the engine guard test). The Kev model goes into config through `config.update`. Tests inject a temp HOME and a fake spawn: nothing is downloaded and no real client config is read or written.

## Schedules (#29)

`config.schedules` (`daily HH:MM`, `weekdays HH:MM`, `fri HH:MM`, `mon,thu HH:MM`, or `off`; local time) runs as OS jobs, so runs happen with the UI closed. `src/system/schedules.ts` writes one job per schedule that is on, each running `node packages/cli/dist/index.js run <skill> --schedule --home <PP_HOME>` (`pp run`: `runs.start` with actor `schedule` and `schedule` set, then `pp drain` until the run and the runs it triggered finish; `scout_score` queues scout and the pipeline queues score and research). The job's environment has `PATH` (node's dir, the runner's dir, the installing shell's PATH, system dirs), `PP_HOME` and `PP_NODE`; output goes to `~/Library/Logs/perfect-placement/<key>.log` (Linux: `~/.local/state/perfect-placement/`).

| OS | Job | Loaded with |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/com.perfectplacement.<key>.plist` (`StartCalendarInterval`; launchd runs a missed slot on wake) | `launchctl bootout` + `bootstrap gui/<uid>` |
| Linux | `~/.config/systemd/user/pp-<key>.{service,timer}` (`OnCalendar`, `Persistent=true`) | `systemctl --user daemon-reload`, `enable --now` |
| other | none: `pp schedules install` prints crontab lines to add | you |

- `pp setup` asks before installing (`--yes` installs, `--no-schedules` skips). `pp schedules install` rewrites and reloads every job; `remove` unloads and deletes them (config untouched); `status` shows spec, next run, last scheduled run and job state (`installed`, `missing`, `stale`, `off`, `orphan`, `manual`).
- Settings toggles save `config.update`; when `schedules` change, `pp up` (and `pp op`) sync the jobs after commit: a schedule turned `off` loses its job, one turned on gets it. Jobs already installed as is are left alone.
- `pp up` catches up: a schedule that is on, ran before, and fired since its last run started (machine off, no job) is queued once at start (`--no-catch-up` skips). A schedule that never ran waits for its job or a Run button.
- `pp doctor` (`schedule_jobs`): fails when installed jobs do not match `config.schedules` (stale, missing next to installed ones, or left over for a schedule turned off). No jobs at all passes with a hint (declined in setup).
- Each job file carries a `pp-schedule <base64>` fingerprint (key, spec, vault, node, cli): status compares files only, never asks launchd or systemd. Tests use a temp HOME and a fake `capture`; nothing runs `launchctl`, `systemctl` or `crontab`.
