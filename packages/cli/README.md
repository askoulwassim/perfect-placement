# @perfect-placement/cli (`pp`)

Thin: every command goes through the engine (`openEngine({ home, services })`; `Io.services` overrides the engine services, tests pass no-network fakes).

```
pp setup   [--runner claude|codex|cursor-agent] [--yes] [--no-kev|--kev] [--model m] [--no-mcp|--mcp claude-code,codex,cursor,claude-desktop] [--no-schedules]
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
pp uninstall [--purge [--no-backup] [--force]] [--yes] [--dry-run] [--bin-dir DIR]   undo setup (keeps the vault unless --purge)
```

Common flags: `--home <dir>` (else `PP_HOME`, else `~/.perfect-placement`), `--actor agent|human|schedule` (default `agent` for `pp op` and the skill commands), `--dry-run`. `--in -` reads stdin.

## `pp up`

One process on 127.0.0.1 (loopback bind and loopback `Host` header only):

| Route | What |
| --- | --- |
| `POST /api/ops/:name` | body = op input JSON; `runOp(name, input, { actor: 'human' })`; returns the `OpOutcome` (200 ok, 202 requires_human, 4xx/5xx by error code). Unknown op 404, bad JSON 400. |
| `GET /api/ops`, `GET /api/health` | op list, health |
| `GET /api/files?path=` | #106: a rendered document (`files/<role_id>/<doc>.pdf` or `.docx`, from `apply.render_documents`) as a download. Read-only; only files an application references, anything else 404. |
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

`--runner` saves the runner through `config.update`; without it setup preserves the current selection. What a runner needs on the machine is registered per runner in `src/system/runners.ts` (`RUNNER_MACHINE`: a setup step and a doctor check; only Codex has them). Only a selected Codex runner offers browser installation. `src/system/codex-browser.ts` installs the standalone, locked `runtimes/codex-browser` package and its upload patch into a PP-owned user cache outside the vault, using pinned pnpm with lifecycle scripts disabled. It verifies the installation before publishing the completed cache directory, and repeated setup reuses it only when the manifest, lockfile and patch contents match. `--mcp codex` registers the agent without selecting it; browser installation still follows the current runner selection. `pp doctor` checks browser readiness for Codex; missing or stale installations are repaired with `pp setup --runner codex`. If Node needs upgrading, rerun `./install.sh` with the upgraded Node to refresh the pinned launchers before retrying setup. Browser runs never install packages. See [Chrome setup](../../docs/install.md#chrome-setup-for-codex).

## Schedules (#29)

`config.schedules` (`daily HH:MM`, `weekdays HH:MM`, `fri HH:MM`, `mon,thu HH:MM`, or `off`; local time) runs as OS jobs, so runs happen with the UI closed. `src/system/schedules.ts` writes one job per schedule that is on, each running `node packages/cli/dist/index.js run <skill> --schedule --home <PP_HOME>` (`pp run`: `runs.start` with actor `schedule` and `schedule` set, then `pp drain` until the run and the runs it triggered finish; `scout_score` queues scout and the pipeline queues score and research). The job's environment has `PATH` (node's dir, the runner's dir, the installing shell's PATH, system dirs), `PP_HOME` and `PP_NODE`; output goes to `~/Library/Logs/perfect-placement/<key>.log` (Linux: `~/.local/state/perfect-placement/`).

Codex schedules also retain browser location settings: `HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `CHROME_CONFIG_HOME`, `LOCALAPPDATA` and `APPDATA` when set. The shell's temp dir is not kept: it varies by shell and would apply to the whole job. These settings reach the browser MCP server explicitly, so it uses the same runtime cache and Chrome profile locations. After changing them, rerun `pp setup --runner codex` for runtime setup and `pp schedules install` to refresh installed jobs.

| OS | Job | Loaded with |
| --- | --- | --- |
| macOS | `~/Library/LaunchAgents/com.perfectplacement.<key>.plist` (`StartCalendarInterval`; launchd runs a missed slot on wake) | `launchctl bootout` + `bootstrap gui/<uid>` |
| Linux | `~/.config/systemd/user/pp-<key>.{service,timer}` (`OnCalendar`, `Persistent=true`) | `systemctl --user daemon-reload`, `enable --now` |
| other | none: `pp schedules install` prints crontab lines to add | you |

- `pp setup` asks before installing (`--yes` installs, `--no-schedules` skips). `pp schedules install` rewrites and reloads every job; `remove` unloads and deletes them (config untouched); `status` shows spec, next run, last scheduled run and job state (`installed`, `missing`, `stale`, `off`, `orphan`, `manual`). Paths compare by file identity (realpath), so a repo, vault or node reached through a symlink is not `stale`.
- Settings toggles save `config.update`; when `schedules` change, `pp up` (and `pp op`) sync the jobs after commit: a schedule turned `off` loses its job, one turned on gets it. Jobs already installed as is are left alone.
- `pp up` catches up: a schedule that is on, ran before, and fired since its last run started (machine off, no job) is queued once at start (`--no-catch-up` skips). A schedule that never ran waits for its job or a Run button.
- Resilience (#121): `pp run --schedule` holds a power assertion on its own pid while it waits (macOS `caffeinate -i -s -w <pid>`; Linux `systemd-inhibit --what=sleep:idle ... tail --pid=<pid>` when available; else nothing), released when it returns. Its drain (and `pp up`'s sweep) stops a scheduled run past its skill's wall-clock cap and finishes it `stalled`; transient failures of scheduled runs are retried after 1, 5, 15 min; when all tries fail, `pp up` catches the schedule up and `pp doctor` shows the last failure (`scheduled_failures`).
- `pp doctor` (`schedule_jobs`): fails when installed jobs do not match `config.schedules` (stale, missing next to installed ones, or left over for a schedule turned off). No jobs at all passes with a hint (declined in setup).
- Each job file carries a `pp-schedule <base64>` fingerprint (key, spec, vault, node, cli, plus browser location settings for Codex): status compares files only, never asks launchd or systemd. Codex jobs with missing or changed browser settings are stale and need refreshing. Tests use a temp HOME and a fake `capture`; nothing runs `launchctl`, `systemctl` or `crontab`.

## `pp uninstall`

`src/commands/uninstall.ts` (plan, prompt, summary) over `src/system/uninstall.ts` (`planUninstall`: read only, one item per thing found, each with a `run`), `src/system/clients.ts` (`unregister*`: only the `pp` entry, `.bak-<timestamp>` first, unparseable files left alone), `src/system/schedules.ts` (`removeJobs`), `src/system/hf-cache.ts` (Kev dirs `models--jaredpalmer--kev-*`, plus the base each pins in its `training_config.json` / `provenance.json` / `adapter_config.json`: only that snapshot, and only blobs no other snapshot references) and `src/system/backup.ts` (tar.gz written with zlib, 0600, read back before the vault is deleted). `./uninstall.sh` at the repo root finds node like `install.sh` and builds the CLI if `dist` is missing. Tests: `src/commands/uninstall.test.ts`, `src/system/uninstall-parts.test.ts` (temp HOME, fake `claude` / `launchctl` / `systemctl` / `crontab`, synthetic HF cache).
