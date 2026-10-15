# Install and run

The [README](../README.md) has the four commands. This page has the detail behind each one, plus troubleshooting.

## Prerequisites

macOS or Linux, Node 22+, git; on macOS the Xcode Command Line Tools (`xcode-select --install`, needed to build `better-sqlite3`). pnpm comes from corepack (bundled with Node), pinned in `package.json`. `./install.sh --check` tells you what is missing and how to fix it, and changes nothing.

## The four commands

```sh
git clone https://github.com/askoulwassim/perfect-placement.git && cd perfect-placement
./install.sh          # checks prerequisites, pnpm install + build, puts pp and pp-mcp in ~/.local/bin
pp setup              # creates your vault, offers Kev, registers pp with the agents it finds
pp up                 # http://127.0.0.1:5177 (Ctrl-C to stop)
```

- **`./install.sh`** never uses sudo and is safe to rerun. It writes two small launchers, `pp` and `pp-mcp`, into `~/.local/bin` (`--bin-dir DIR` to change). Each one runs this clone's build with the absolute `node` it found, so a different `node` on your PATH later does not break it. If `~/.local/bin` is not on your PATH it prints the line to add. If Node 22 is a Homebrew keg (`node@22`) that is not on PATH, it uses it and prints the PATH line. Moved the clone or pulled new code? Rerun `./install.sh`.
- **`pp: Input file setup was not found`?** macOS ships an unrelated `/usr/bin/pp`. Open a new terminal (or run `rehash` in zsh, `hash -r` in bash) so your shell finds the new launcher; if `~/.local/bin` comes after `/usr/bin` on your PATH, `install.sh` prints the line that puts it first.
- **`pp setup`** asks before each step and is safe to rerun: (a) creates the vault at `PP_HOME` if there is none, (b) offers Kev, (c) for each agent it finds (Claude Code, Codex, Cursor, Claude Desktop) asks, then registers the stdio `pp-mcp` server under the name `pp`, printing exactly what it changed, then how to load it: clients read MCP config only at launch, so **restart the client** (Claude Code, Codex, Cursor), and for Claude Desktop **quit it (Cmd+Q) and reopen it**; pp then appears under Settings > Developer. It never touches other MCP servers and backs up any config file before editing it (`<file>.bak-<timestamp>`). Non-interactive: `pp setup --yes`, plus `--no-kev`, `--no-mcp`, `--mcp claude-code,cursor`, `--model kev-0.8b`.
- **pp not showing in your agent?** Restart it after `pp setup` (closing the window is not enough for Claude Desktop: Cmd+Q, then reopen). In Claude Desktop a local MCP server shows under **Settings > Developer** and in the tools menu of a chat, not under Connectors; its log is `~/Library/Logs/Claude/mcp-server-pp.log`. Still missing? Rerun `pp setup --mcp claude-desktop` and check the log.
- **`pp up`** serves the web UI, the API (`/api/ops`) and MCP over HTTP (`/mcp`) on 127.0.0.1 only. If Kev is installed and not running it starts it, and stops it on exit (`--no-kev` to skip). On a fresh vault the UI opens on You, which is setup (onboarding) until a profile exists; then a Getting started card on Now walks the first steps once (profile, policy, first scout, review, first role) and goes away when they are done.

## Troubleshooting

- **`pnpm: command not found`.** pnpm comes through corepack and isn't a plain command by default. `./install.sh` runs it for you; for a plain `pnpm`, run `corepack enable` once.
- **`Failed to create bin … pp-mcp` warnings during `./install.sh` after deleting `dist/`.** pnpm links the workspace's own commands before the build exists. They're harmless (your `pp` and `pp-mcp` launchers point straight at the build); rerun `./install.sh` and they're gone.
- **`Cannot find module …/packages/cli/dist/index.js`.** The build is missing (for example after `rm -rf packages/*/dist`). Run `./install.sh`.

## Try it on demo data

`pp up --fixtures` runs the app on a synthetic vault in a temp folder. Nothing touches your real vault.

## Your data persists

Everything lives in the vault (`~/.perfect-placement` or `PP_HOME`): `pp.db` (SQLite) plus markdown files and `config.json`. Closing `pp up` (or rebooting) loses nothing: run `pp up` again days later and continue where you left off. `pp doctor` checks the vault's integrity.

## Reconnect an agent

Rerun `pp setup` (or `pp setup --mcp claude-code`) after installing a new agent, moving the clone, or changing `PP_HOME`. Restart the agent afterwards (Claude Desktop: Cmd+Q and reopen; pp shows under Settings > Developer). Manual config snippets for each client are in `packages/mcp/README.md`. While `pp up` runs, an agent can also use `http://127.0.0.1:5177/mcp`.

## Kev (optional)

Kev is a small local model that answers the system's typed yes/no and pick-one questions so fewer of them reach you. pp works without it: those questions go to your agent session or to Needs you.

```sh
pp kev install [--model kev-0.8b]   # into $PP_HOME/kev/ (git clone + uv sync); needs uv
pp kev start | stop | status         # background process; pid + log in $PP_HOME/kev/
```

Supported: Apple Silicon (MLX), and Linux with an NVIDIA GPU (the Kev README's PyTorch/CUDA path). The first start downloads the model from Hugging Face (several GB). Memory: `kev-4b` (default) wants 8 GB+ free, so on a 16 GB machine use `--model kev-0.8b` (~4 GB). The choice is stored in `config.json` (`backends.kev.model`). Details: `packages/resolver/docs/kev-setup.md`.

## Documents and Open and fill

On a role's **Resume** and **Cover** tabs, **Download** gives the tailored document as PDF or DOCX (one clean, ATS-friendly template, rendered from the markdown into the vault's `files/<role_id>/`). At the Fill stage the primary is **Open and fill**: with Claude Code and Claude in Chrome, or Codex and Chrome DevTools MCP, the fill run answers the portal's questions, opens the portal, uploads the resume and cover letter PDFs, fills the answer fields, and stops before Submit with the tab left open for you. Then the primary is **Open portal**. You review and submit; pp never does.

### Chrome setup for Codex

Run `pp setup --runner codex` to select Codex and install its pinned browser runtime. If Codex is already selected, rerunning `pp setup` offers the same installation. Other runners do not install it. `pp setup --mcp codex` registers the PP MCP server with Codex without selecting the runner; browser installation still follows the currently selected runner.

The browser package has its own manifest, lockfile and upload patch outside the normal workspace dependencies. Setup needs Corepack or pnpm 9.15.9 and installs it into a PP-owned user cache, using the locked version with lifecycle scripts disabled. The patch permits uploads only through actual file inputs. Runs launch the installed JavaScript with an absolute Node path and need no package manager or downloads. After an update changes the pinned runtime or patch, rerun setup; older installations are not reused. A missing runtime affects browser work only; Codex's other skills can still run. Switching runners leaves the cache in place and stops using it.

On Node 22, browser support requires **22.12 or newer**; this does not change the requirements for the other runners. After upgrading Node, rerun `./install.sh` from the checkout with the upgraded Node on PATH to refresh pp's pinned launchers, then run `pp setup --runner codex`. Selecting a newer Node in your shell alone does not update those launchers.

Chrome must be 144 or newer. To let pp connect to your existing Chrome session:

1. Open Chrome 144 or newer and keep it running.
2. Open `chrome://inspect/#remote-debugging` in Chrome.
3. Check **Allow remote debugging for this browser instance**.
4. Start **Open and fill** in pp. When Chrome asks to allow the connection, click **Allow**. Enabling the checkbox alone does not approve that connection.

The agent is instructed to work in a new portal tab and leave it open for your review; the adapter does not enforce tab ownership. Review the remaining fields before submitting: custom dropdowns that do not retain selections, questions without saved answers, and demographic questions you chose to answer yourself are reported as skipped. PP's browser adapter exposes no click, key, script or submit tools; filling a checkbox or radio clicks only that control, and short answers cannot contain line breaks or tabs, which would be typed as key presses.

PP's browser adapter permits uploads only of the role's rendered `resume.pdf` and `cover_letter.pdf`. It rejects other file paths, including links escaping that directory, and snapshots cannot be saved to files. An upload aimed at another element fails without clicking it; buttons that open file choosers are unsupported. If document rendering fails, form filling remains available but uploads are withheld and reported as skipped.

If a run reports `setup required` for the browser, complete the steps above and retry it; missing setup is not retried automatically. Gmail is a separate connection: selecting Codex or enabling Chrome debugging does not connect Gmail. See the [runner connector details](../packages/engine/runners/README.md) and [Chrome DevTools MCP setup](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md).

## Email check

Guessed contact addresses are checked passively before they reach Needs you: syntax, the domain's MX (or A) record over DNS, disposable / role / free-mail lists, and the address format of real colleagues the connect skill finds in your own Gmail (read-only) or on public pages. Nothing ever connects to a mail server or a verification site, and no paid service or key is needed. An address seen exactly, or a format two colleagues share, is confirmed without asking; a domain with no mail records is dropped; the rest waits in Needs you, where **Check** opens an address checker (with the address copied) and **Valid** / **Invalid** records what you saw. Gmail drafts wait until the address is confirmed, then get their To.

## Scheduled runs

Scheduled runs (`pp schedules`) keep the Mac awake while they run (`caffeinate`, released when the run ends; Linux: `systemd-inhibit` if present), stop a run that hangs past its skill's time cap, and retry a dropped connection or a stalled run after 1, 5 and 15 minutes. If every try fails, the next `pp up` runs the schedule again and `pp doctor` shows the last failure.

## Uninstall

See [uninstall.md](uninstall.md).
