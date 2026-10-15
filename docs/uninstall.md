# Uninstall

```sh
./uninstall.sh                 # setup reset: keeps your vault
./uninstall.sh --purge         # also deletes the vault (backup first) and Kev's model files
./uninstall.sh --dry-run       # print the plan only (add --purge to see the full one)
```

`./uninstall.sh` runs `pp uninstall` with the same node `install.sh` finds (building the CLI first if needed). It prints the exact plan, asks (default no; `--yes` skips the question), then ends with an ok / skip / FAIL line per item (exit 1 if anything failed). Safe to rerun: the second time it says "nothing to remove".

- **Default (setup reset):** stops the Kev that pp started; removes pp's schedule jobs (launchd plists, systemd user timers; with cron it prints the lines for you to remove); removes only the `pp` MCP server from Claude Code (`claude mcp remove --scope user pp`, or `~/.claude.json` when `claude` is not on PATH), Codex, Cursor and Claude Desktop, backing up each file first (`<file>.bak-<timestamp>`) and skipping files without it; deletes the `pp` / `pp-mcp` launchers in `~/.local/bin` (`--bin-dir DIR`) only if they are Perfect Placement launchers. Your vault stays.
- **`--purge`:** also writes a backup of the vault to `~/perfect-placement-backups/vault-<timestamp>.tar.gz` (mode 0600, without `kev/repo`; read back before anything is deleted; `--no-backup` skips it), deletes the vault (`PP_HOME`, including `kev/`), and deletes Kev's own files in the Hugging Face cache: the `models--jaredpalmer--kev-*` dirs and the base model snapshot each one pins, keeping any blob another model also uses. It refuses a `PP_HOME` inside a git repo, one without `pp.db` and `config.json`, or while `pp up` runs, unless `--force`; it never purges your home directory. Restore: `tar -xzf <backup> -C ~`.
- **Never touched:** Node, pnpm, uv, Homebrew, this checkout, your agents' other MCP servers. The end of the run prints the optional commands for a full machine reset (Node 22, pnpm shims, uv, the repo).

The optional browser runtime cache (Codex and Cursor) is also retained: another PP vault, checkout or running session may share it. It contains the installed runtime and its package and patch metadata, outside the vault, under `$XDG_CACHE_HOME/perfect-placement/browser` (or `~/.cache/perfect-placement/browser`). Switching to another runner stops using it without deleting it. Versions before the rename kept it in `perfect-placement/codex-browser`; that folder is no longer used and can be deleted by hand.
