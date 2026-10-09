# Perfect Placement

A local, agent-first job-search system: scout, score, keep fresh, tailor, connect, watch the inbox, learn. The repo is the system only; your data lives in a local vault (`~/.perfect-placement`, override with `PP_HOME`) and is never committed.

Status: **Wave 2 integrated** (engine, decision layer, MCP, web UI on live ops). See `AGENTS.md` for how agents work here.

> **Not done yet (pinned):** vault backup and a public release. Until backup lands, copy `~/.perfect-placement` yourself if you care about it. This is a working tree, not a packaged release.

## Quickstart (fresh machine)

**Prerequisites:** macOS or Linux, Node 22+, git; on macOS the Xcode Command Line Tools (`xcode-select --install`, needed to build `better-sqlite3`). pnpm comes from corepack (bundled with Node), pinned in `package.json`. `./install.sh --check` tells you what is missing and how to fix it, and changes nothing.

```sh
git clone <this repo> perfect-placement && cd perfect-placement
./install.sh          # checks prerequisites, pnpm install + build, puts pp and pp-mcp in ~/.local/bin
pp setup              # creates your vault, offers Kev, registers pp with the agents it finds
pp up                 # http://127.0.0.1:5177 (Ctrl-C to stop)
```

- **`./install.sh`** never uses sudo and is safe to rerun. It writes two small launchers, `pp` and `pp-mcp`, into `~/.local/bin` (`--bin-dir DIR` to change). Each one runs this clone's build with the absolute `node` it found, so a different `node` on your PATH later does not break it. If `~/.local/bin` is not on your PATH it prints the line to add. If Node 22 is a Homebrew keg (`node@22`) that is not on PATH, it uses it and prints the PATH line. Moved the clone or pulled new code? Rerun `./install.sh`.
- **`pp: Input file setup was not found`?** macOS ships an unrelated `/usr/bin/pp`. Open a new terminal (or run `rehash` in zsh, `hash -r` in bash) so your shell finds the new launcher; if `~/.local/bin` comes after `/usr/bin` on your PATH, `install.sh` prints the line that puts it first.
- **`pp setup`** asks before each step and is safe to rerun: (a) creates the vault at `PP_HOME` if there is none, (b) offers Kev, (c) for each agent it finds (Claude Code, Codex, Cursor, Claude Desktop) asks, then registers the stdio `pp-mcp` server under the name `pp`, printing exactly what it changed, then how to load it: clients read MCP config only at launch, so **restart the client** (Claude Code, Codex, Cursor), and for Claude Desktop **quit it (Cmd+Q) and reopen it**; pp then appears under Settings > Developer. It never touches other MCP servers and backs up any config file before editing it (`<file>.bak-<timestamp>`). Non-interactive: `pp setup --yes`, plus `--no-kev`, `--no-mcp`, `--mcp claude-code,cursor`, `--model kev-0.8b`.
- **pp not showing in your agent?** Restart it after `pp setup` (closing the window is not enough for Claude Desktop: Cmd+Q, then reopen). In Claude Desktop a local MCP server shows under **Settings > Developer** and in the tools menu of a chat, not under Connectors; its log is `~/Library/Logs/Claude/mcp-server-pp.log`. Still missing? Rerun `pp setup --mcp claude-desktop` and check the log.
- **`pp up`** serves the web UI, the API (`/api/ops`) and MCP over HTTP (`/mcp`) on 127.0.0.1 only. If Kev is installed and not running it starts it, and stops it on exit (`--no-kev` to skip). On a fresh vault the UI opens on You, which is setup (onboarding) until a profile exists; then a Getting started card on Now walks the first steps once (profile, policy, first scout, review, first role) and goes away when they are done.

### Your data persists

Everything lives in the vault (`~/.perfect-placement` or `PP_HOME`): `pp.db` (SQLite) plus markdown files and `config.json`. Closing `pp up` (or rebooting) loses nothing: run `pp up` again days later and continue where you left off. `pp doctor` checks the vault's integrity.

### Reconnect an agent

Rerun `pp setup` (or `pp setup --mcp claude-code`) after installing a new agent, moving the clone, or changing `PP_HOME`. Restart the agent afterwards (Claude Desktop: Cmd+Q and reopen; pp shows under Settings > Developer). Manual config snippets for each client are in `packages/mcp/README.md`. While `pp up` runs, an agent can also use `http://127.0.0.1:5177/mcp`.

### Kev (optional)

Kev is a small local model that answers the system's typed yes/no and pick-one questions so fewer of them reach you. pp works without it: those questions go to your agent session or to Needs you.

```sh
pp kev install [--model kev-0.8b]   # into $PP_HOME/kev/ (git clone + uv sync); needs uv
pp kev start | stop | status         # background process; pid + log in $PP_HOME/kev/
```

Supported: Apple Silicon (MLX), and Linux with an NVIDIA GPU (the Kev README's PyTorch/CUDA path). The first start downloads the model from Hugging Face (several GB). Memory: `kev-4b` (default) wants 8 GB+ free, so on a 16 GB machine use `--model kev-0.8b` (~4 GB). The choice is stored in `config.json` (`backends.kev.model`). Details: `packages/resolver/docs/kev-setup.md`.

### Email check (optional)

Guessed contact addresses are checked before they reach Needs you: the domain's MX record always, and, if you pick a provider in **Settings > Email check** (NeverBounce, ZeroBounce or Hunter), each candidate mailbox with your own key. Put the key in an environment variable (default `NEVERBOUNCE_API_KEY`, `ZEROBOUNCE_API_KEY` or `HUNTER_API_KEY`, or the name you set under **Key variable**) in the shell that runs `pp up`; it is never stored in `config.json` or the db. A deliverable address is confirmed without asking; an undeliverable one is dropped. Gmail drafts wait until the address is confirmed, then get their To.

## Uninstall

```sh
./uninstall.sh                 # setup reset: keeps your vault
./uninstall.sh --purge         # also deletes the vault (backup first) and Kev's model files
./uninstall.sh --dry-run       # print the plan only (add --purge to see the full one)
```

`./uninstall.sh` runs `pp uninstall` with the same node `install.sh` finds (building the CLI first if needed). It prints the exact plan, asks (default no; `--yes` skips the question), then ends with an ok / skip / FAIL line per item (exit 1 if anything failed). Safe to rerun: the second time it says "nothing to remove".

- **Default (setup reset):** stops the Kev that pp started; removes pp's schedule jobs (launchd plists, systemd user timers; with cron it prints the lines for you to remove); removes only the `pp` MCP server from Claude Code (`claude mcp remove --scope user pp`, or `~/.claude.json` when `claude` is not on PATH), Codex, Cursor and Claude Desktop, backing up each file first (`<file>.bak-<timestamp>`) and skipping files without it; deletes the `pp` / `pp-mcp` launchers in `~/.local/bin` (`--bin-dir DIR`) only if they are Perfect Placement launchers. Your vault stays.
- **`--purge`:** also writes a backup of the vault to `~/perfect-placement-backups/vault-<timestamp>.tar.gz` (mode 0600, without `kev/repo`; read back before anything is deleted; `--no-backup` skips it), deletes the vault (`PP_HOME`, including `kev/`), and deletes Kev's own files in the Hugging Face cache: the `models--jaredpalmer--kev-*` dirs and the base model snapshot each one pins, keeping any blob another model also uses. It refuses a `PP_HOME` inside a git repo, one without `pp.db` and `config.json`, or while `pp up` runs, unless `--force`; it never purges your home directory. Restore: `tar -xzf <backup> -C ~`.
- **Never touched:** Node, pnpm, uv, Homebrew, this checkout, your agents' other MCP servers. The end of the run prints the optional commands for a full machine reset (Node 22, pnpm shims, uv, the repo).

## Developing

```sh
corepack enable
pnpm i && pnpm build && pnpm test && pnpm lint
pp up --fixtures      # demo on synthetic data
```
