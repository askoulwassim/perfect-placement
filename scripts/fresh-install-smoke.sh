#!/bin/sh
# Fresh-user smoke: pp setup on an empty PP_HOME, pp up, write through the API, stop, start again,
# read it back (the vault persists across restarts). Synthetic data only; never touches a real vault.
#   PP=pp PORT=5199 PP_HOME=<temp> scripts/fresh-install-smoke.sh
set -eu

PP=${PP:-pp}
PORT=${PORT:-5199}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/pp-smoke.XXXXXX")
PP_HOME=${PP_HOME:-$WORK/vault}
export PP_HOME
LOG="$WORK/up.log"
URL="http://127.0.0.1:$PORT"
PID=""

fail() {
  echo "smoke: FAIL: $1" >&2
  [ -f "$LOG" ] && sed 's/^/  up.log: /' "$LOG" >&2
  [ -n "$PID" ] && kill -TERM "$PID" 2>/dev/null
  exit 1
}

start() {
  $PP up --no-kev --port "$PORT" >>"$LOG" 2>&1 &
  PID=$!
  i=0
  until curl -fsS "$URL/api/health" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -le 60 ] || fail "pp up did not answer on $URL"
    kill -0 "$PID" 2>/dev/null || fail "pp up exited"
    sleep 0.5
  done
  echo "smoke: pp up running (pid $PID) at $URL"
}

stop() {
  kill -TERM "$PID"
  wait "$PID" || true
  PID=""
  echo "smoke: pp up stopped"
}

op() { # name json
  curl -fsS -X POST "$URL/api/ops/$1" -H 'content-type: application/json' -d "$2"
}

echo "smoke: PP_HOME=$PP_HOME"
$PP setup --yes --no-kev --no-mcp --no-schedules
[ -f "$PP_HOME/pp.db" ] || fail "no pp.db after setup"

start
added=$(op roles.add '{"candidates":[{"company_name":"Example Co","title":"Smoke Test PM","source":"manual"}]}')
echo "smoke: roles.add -> $added"
echo "$added" | grep -q '"example_smoke-test-pm"' || fail "roles.add did not add example_smoke-test-pm"
stop

start
role=$(op roles.get '{"role_id":"example_smoke-test-pm"}')
company=$(op companies.get '{"company_id":"example"}')
stop
echo "$role" | grep -q '"status":"ok"' || fail "role not found after restart: $role"
echo "$role" | grep -q '"title":"Smoke Test PM"' || fail "role title lost: $role"
echo "$company" | grep -q '"name":"Example Co"' || fail "company name changed: $company"
echo "smoke: after restart: role example_smoke-test-pm (inbox), company \"Example Co\""
$PP doctor >/dev/null || fail "pp doctor failed"
echo "smoke: ok"
