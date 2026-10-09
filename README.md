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
- **`pp setup`** asks before each step and is safe to rerun: (a) creates the vault at `PP_HOME` if there is none, (b) offers Kev, (c) for each agent it finds (Claude Code, Codex, Cursor, Claude Desktop) asks, then registers the stdio `pp-mcp` server under the name `pp`, printing exactly what it changed. It never touches other MCP servers and backs up any config file before editing it (`<file>.bak-<timestamp>`). Non-interactive: `pp setup --yes`, plus `--no-kev`, `--no-mcp`, `--mcp claude-code,cursor`, `--model kev-0.8b`.
- **`pp up`** serves the web UI, the API (`/api/ops`) and MCP over HTTP (`/mcp`) on 127.0.0.1 only. If Kev is installed and not running it starts it, and stops it on exit (`--no-kev` to skip).

### Your data persists

Everything lives in the vault (`~/.perfect-placement` or `PP_HOME`): `pp.db` (SQLite) plus markdown files and `config.json`. Closing `pp up` (or rebooting) loses nothing: run `pp up` again days later and continue where you left off. `pp doctor` checks the vault's integrity.

### Reconnect an agent

Rerun `pp setup` (or `pp setup --mcp claude-code`) after installing a new agent, moving the clone, or changing `PP_HOME`. Restart the agent afterwards. Manual config snippets for each client are in `packages/mcp/README.md`. While `pp up` runs, an agent can also use `http://127.0.0.1:5177/mcp`.

### Kev (optional)

Kev is a small local model that answers the system's typed yes/no and pick-one questions so fewer of them reach you. pp works without it: those questions go to your agent session or to Needs you.

```sh
pp kev install [--model kev-0.8b]   # into $PP_HOME/kev/ (git clone + uv sync); needs uv
pp kev start | stop | status         # background process; pid + log in $PP_HOME/kev/
```

Supported: Apple Silicon (MLX), and Linux with an NVIDIA GPU (the Kev README's PyTorch/CUDA path). The first start downloads the model from Hugging Face (several GB). Memory: `kev-4b` (default) wants 8 GB+ free, so on a 16 GB machine use `--model kev-0.8b` (~4 GB). The choice is stored in `config.json` (`backends.kev.model`). Details: `packages/resolver/docs/kev-setup.md`.

## Developing

```sh
corepack enable
pnpm i && pnpm build && pnpm test && pnpm lint
pp up --fixtures      # demo on synthetic data
```
