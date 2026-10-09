#!/bin/sh
# Perfect Placement installer (macOS + Linux). Safe to rerun; never uses sudo.
#
#   ./install.sh                 check prerequisites, pnpm install + build, put `pp` and `pp-mcp` on PATH
#   ./install.sh --check         only report what is missing (changes nothing)
#   ./install.sh --bin-dir DIR   where the `pp` / `pp-mcp` launchers go (default ~/.local/bin)
#
# The launchers are two-line sh scripts that exec this clone's build with the absolute node used
# here, so `pp` keeps working when another node is first on PATH. Moving the clone = rerun this.
set -eu

CHECK=0
BIN_DIR="${PP_BIN_DIR:-${HOME}/.local/bin}"
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1 ;;
    --bin-dir)
      [ $# -ge 2 ] || { echo "install.sh: --bin-dir needs a directory" >&2; exit 2; }
      BIN_DIR="$2"
      shift
      ;;
    --bin-dir=*) BIN_DIR="${1#--bin-dir=}" ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "install.sh: unknown option $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

REPO=$(cd "$(dirname "$0")" && pwd -P)
OS=$(uname -s)
MISSING=0

ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  MISS  %s\n        fix: %s\n' "$1" "$2"; MISSING=$((MISSING + 1)); }
note() { printf '  note  %s\n' "$1"; }

echo "Perfect Placement: checking prerequisites ($OS)"

# --- Node >= 22 --------------------------------------------------------------
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node_major node)" -ge 22 ]; then
  NODE=$(command -v node)
  ok "node $(node -v) ($NODE)"
else
  # PP_NODE_KEGS overrides the Homebrew keg dirs searched (tests).
  for keg in ${PP_NODE_KEGS-/opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin}; do
    if [ -x "$keg/node" ] && [ "$(node_major "$keg/node")" -ge 22 ]; then
      NODE="$keg/node"
      PATH="$keg:$PATH"
      export PATH
      ok "node $("$NODE" -v) (Homebrew keg $keg, not on your PATH)"
      note "add it to your shell profile: export PATH=\"$keg:\$PATH\""
      break
    fi
  done
  if [ -z "$NODE" ]; then
    found=$(command -v node 2>/dev/null || true)
    if [ "$OS" = Darwin ]; then fix="brew install node@22, then: export PATH=\"\$(brew --prefix node@22)/bin:\$PATH\""
    else fix="install Node 22 LTS (https://nodejs.org, or nvm install 22 / fnm install 22)"; fi
    bad "node >= 22${found:+ (found $(node -v 2>/dev/null) at $found)}" "$fix"
  fi
fi

# --- pnpm (via corepack, pinned by package.json) ------------------------------
PNPM=""
if [ -n "$NODE" ]; then
  NODE_BIN=$(dirname "$NODE")
  if command -v pnpm >/dev/null 2>&1; then
    PNPM="pnpm"
    ok "pnpm $(pnpm -v 2>/dev/null || echo '?') ($(command -v pnpm))"
  elif [ -x "$NODE_BIN/corepack" ] || command -v corepack >/dev/null 2>&1; then
    # `corepack pnpm` runs the version pinned in package.json without writing shims anywhere.
    PNPM="corepack pnpm"
    ok "pnpm via corepack (pinned in package.json)"
    note "to get a plain pnpm command: corepack enable (or: corepack enable --install-directory $BIN_DIR)"
  else
    bad "pnpm / corepack" "npm install -g corepack && corepack enable"
  fi
fi

# --- git -----------------------------------------------------------------------
if command -v git >/dev/null 2>&1; then ok "git"; else
  if [ "$OS" = Darwin ]; then bad "git" "xcode-select --install"; else bad "git" "install git with your package manager (apt install git)"; fi
fi

# --- native build tools for better-sqlite3 ------------------------------------
if [ "$OS" = Darwin ]; then
  if xcode-select -p >/dev/null 2>&1; then ok "Xcode Command Line Tools"; else
    bad "Xcode Command Line Tools (needed to build better-sqlite3)" "xcode-select --install"
  fi
else
  if command -v make >/dev/null 2>&1 && { command -v c++ >/dev/null 2>&1 || command -v g++ >/dev/null 2>&1; }; then ok "C/C++ toolchain"
  else note "no C/C++ toolchain: fine if better-sqlite3 has a prebuilt binary; otherwise apt install build-essential python3"; fi
fi

# --- bin dir ---------------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac

if [ "$CHECK" -eq 1 ]; then
  if [ "$ON_PATH" -eq 1 ]; then ok "$BIN_DIR is on PATH"; else note "$BIN_DIR is not on PATH (install prints the line to add)"; fi
  if [ -x "$BIN_DIR/pp" ]; then ok "pp launcher at $BIN_DIR/pp"; else note "pp launcher not installed yet"; fi
  if [ "$MISSING" -gt 0 ]; then echo "check: $MISSING missing"; exit 1; fi
  echo "check: ready (run ./install.sh)"
  exit 0
fi
if [ "$MISSING" -gt 0 ]; then
  echo "install.sh: fix the $MISSING item(s) above, then rerun ./install.sh" >&2
  exit 1
fi

# --- install + build ---------------------------------------------------------------
echo "Installing dependencies (pnpm install --frozen-lockfile)"
cd "$REPO"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0
OPENUI_TELEMETRY_DISABLED=1
NPM_CONFIG_UPDATE_NOTIFIER=false
export COREPACK_ENABLE_DOWNLOAD_PROMPT OPENUI_TELEMETRY_DISABLED NPM_CONFIG_UPDATE_NOTIFIER
# $PNPM is one or two words ("pnpm" or "corepack pnpm"): split on purpose.
# shellcheck disable=SC2086
$PNPM install --frozen-lockfile
echo "Building (pnpm build)"
# shellcheck disable=SC2086
$PNPM build

# --- launchers -----------------------------------------------------------------------
write_launcher() { # name target
  dest="$BIN_DIR/$1"
  # PP_NODE tells pp setup which node to write into agent MCP configs (the stable path, not a versioned Cellar dir).
  content=$(printf '#!/bin/sh\nPP_NODE="%s" exec "%s" "%s" "$@"\n' "$NODE" "$NODE" "$2")
  if [ -f "$dest" ] && [ "$(cat "$dest")" = "$content" ]; then
    ok "$dest (unchanged)"
    return
  fi
  if [ -e "$dest" ] && ! grep -qF '/packages/' "$dest" 2>/dev/null; then
    echo "install.sh: $dest exists and is not a Perfect Placement launcher; leaving it alone" >&2
    exit 1
  fi
  printf '%s\n' "$content" >"$dest.tmp.$$"
  chmod 755 "$dest.tmp.$$"
  mv "$dest.tmp.$$" "$dest"
  ok "$dest -> $2"
}
mkdir -p "$BIN_DIR"
write_launcher pp "$REPO/packages/cli/dist/index.js"
write_launcher pp-mcp "$REPO/packages/mcp/dist/bin.js"

echo ""
echo "Done."
if [ "$ON_PATH" -eq 0 ]; then
  echo "Add this to your shell profile (~/.zshrc or ~/.bashrc), then open a new terminal:"
  echo "  export PATH=\"$BIN_DIR:\$PATH\""
fi
echo "Next: pp setup, then pp up"
