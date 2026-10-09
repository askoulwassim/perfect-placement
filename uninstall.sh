#!/bin/sh
# Perfect Placement uninstaller (macOS + Linux). Runs `pp uninstall` with the right node; never uses sudo.
#
#   ./uninstall.sh                     setup reset: stop pp's Kev, remove schedule jobs, the pp MCP entry
#                                      in each agent (backup first) and the pp / pp-mcp launchers; keeps your vault
#   ./uninstall.sh --purge             also delete the vault (tar.gz backup in ~/perfect-placement-backups first)
#                                      and Kev's model files in the Hugging Face cache
#   ./uninstall.sh --dry-run [...]     print the plan only
#   options: --yes  --no-backup  --force  --home DIR  --bin-dir DIR (default ~/.local/bin)
#
# Prints the plan and asks first (default no). Never touches Node, pnpm, uv, Homebrew or this checkout.
set -eu

case "${1:-}" in
  -h | --help)
    sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

REPO=$(cd "$(dirname "$0")" && pwd -P)

# --- node >= 22 (same search as install.sh: PP_NODE, PATH, Homebrew node@22 keg) ---------
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE=""
if [ -n "${PP_NODE:-}" ] && [ -x "$PP_NODE" ] && [ "$(node_major "$PP_NODE")" -ge 22 ]; then
  NODE="$PP_NODE"
elif command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge 22 ]; then
  NODE=$(command -v node)
else
  # PP_NODE_KEGS overrides the Homebrew keg dirs searched (tests).
  for keg in ${PP_NODE_KEGS-/opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin}; do
    if [ -x "$keg/node" ] && [ "$(node_major "$keg/node")" -ge 22 ]; then
      NODE="$keg/node"
      PATH="$keg:$PATH"
      export PATH
      break
    fi
  done
fi
if [ -z "$NODE" ]; then
  echo "uninstall.sh: needs node >= 22 to run pp uninstall (set PP_NODE=/path/to/node)" >&2
  exit 1
fi

# --- the CLI build (pp uninstall lives in packages/cli/dist) -----------------------------
CLI="$REPO/packages/cli/dist/index.js"
if [ ! -f "$CLI" ]; then
  echo "uninstall.sh: building the pp CLI first ($CLI is missing)"
  cd "$REPO"
  COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  OPENUI_TELEMETRY_DISABLED=1
  export COREPACK_ENABLE_DOWNLOAD_PROMPT OPENUI_TELEMETRY_DISABLED
  NODE_BIN=$(dirname "$NODE")
  if command -v pnpm >/dev/null 2>&1; then PNPM="pnpm"
  elif [ -x "$NODE_BIN/corepack" ]; then PNPM="$NODE_BIN/corepack pnpm"
  elif command -v corepack >/dev/null 2>&1; then PNPM="corepack pnpm"
  else
    echo "uninstall.sh: no pnpm or corepack; run ./install.sh first" >&2
    exit 1
  fi
  # $PNPM is one or two words: split on purpose.
  # shellcheck disable=SC2086
  [ -d "$REPO/node_modules" ] || $PNPM install --frozen-lockfile
  # shellcheck disable=SC2086
  $PNPM --filter '@perfect-placement/cli...' build
fi

PP_NODE="$NODE"
export PP_NODE
exec "$NODE" "$CLI" uninstall "$@"
