#!/bin/bash
# Phase 1 acceptance (design doc §12, Task 11 + B4 runtime half), Mac dev form.
# Boots a fresh gateway on a scratch data root, drives two users end to end
# through curl/node, and prints PASS/FAIL per check. Requires the repo's Node
# (see .nvmrc) on PATH; no API key needed (no model turns are driven).
set -u
cd "$(dirname "$0")/.."

PORT="${ACCEPT_PORT:-18899}"
ORIGIN="http://127.0.0.1:$PORT"
ROOT="$(mktemp -d /tmp/hgw-accept-XXXXXX)"
LOG="$ROOT/gateway.log"
JAR_ADMIN="$ROOT/admin.jar"; JAR_U1="$ROOT/u1.jar"; JAR_U2="$ROOT/u2.jar"
PASS=0; FAIL=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1"
  else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected $2, got $3)"; fi
}

echo "== scratch root: $ROOT"
# The guard plugin is mounted by package name; instances load its built lib/.
if [ ! -f ../plugins/dsh-directory-guard/lib/index.js ]; then
  (cd ../plugins/dsh-directory-guard && npx tsc -p tsconfig.build.json)
fi
HGW_PORT="$PORT" HGW_DATA_DIR="$ROOT/data" HGW_USERS_ROOT="$ROOT/users" \
  npx tsx src/index.ts >"$LOG" 2>&1 &
GW_PID=$!
trap 'kill $GW_PID 2>/dev/null; wait $GW_PID 2>/dev/null' EXIT

for _ in $(seq 1 50); do
  curl -sf "$ORIGIN/healthz" >/dev/null 2>&1 && break
  sleep 0.2
done
check "gateway healthz" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/healthz")"

ADMIN_PW="$(sed -n 's/.*username: admin  password: //p' "$LOG" | head -1)"
[ -n "$ADMIN_PW" ] || { echo "FATAL: bootstrap admin password not found in $LOG"; exit 1; }

login() { # login <jar> <user> <pw> -> http code (302 on success)
  curl -s -o /dev/null -w '%{http_code}' -c "$1" -H "Origin: $ORIGIN" \
    -d "username=$2&password=$3" "$ORIGIN/login"
}
change_pw() { # change_pw <jar> <newpw>
  curl -s -o /dev/null -w '%{http_code}' -b "$1" -c "$1" -H "Origin: $ORIGIN" \
    -d "password=$2" "$ORIGIN/account/password"
}

# -- admin bootstrap: login, forced password change, create two users --------
check "admin first login" "302" "$(login "$JAR_ADMIN" admin "$ADMIN_PW")"
check "pre-change API is password-gated" "403" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -X POST "$ORIGIN/api/session.list" -d '{}')"
check "admin password change" "302" "$(change_pw "$JAR_ADMIN" admin-pw-9999)"
check "create u1" "302" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -H "Origin: $ORIGIN" -d 'username=u1&password=init-pw-111&role=user' "$ORIGIN/admin/users")"
check "create u2" "302" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -H "Origin: $ORIGIN" -d 'username=u2&password=init-pw-222&role=user' "$ORIGIN/admin/users")"

wait_ready() { # wait_ready <jar> — first hit answers 503/waiting page while booting; poll to 200
  local code=""
  for _ in $(seq 1 120); do
    code="$(curl -s -o /dev/null -w '%{http_code}' -b "$1" "$ORIGIN/")"
    [ "$code" = "200" ] && break
    sleep 0.5
  done
  echo "$code"
}

# -- u1: login -> change pw -> instance boots -> privileged API reachable ----
check "u1 login" "302" "$(login "$JAR_U1" u1 init-pw-111)"
check "u1 password change" "302" "$(change_pw "$JAR_U1" u1-pw-11111)"
FIRST="$(curl -s -b "$JAR_U1" -o /dev/null -w '%{http_code}' "$ORIGIN/api/session.list" -X POST -d '{}')"
check "first request while booting answers 503 instance-starting" "503" "$FIRST"
echo "   (instance booting; polling until ready…)"
check "u1 index through proxy (after boot)" "200" "$(wait_ready "$JAR_U1")"
check "u1 settings.describe through gateway (the public-deploy 403 is gone)" "200" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_U1" -X POST "$ORIGIN/api/settings.describe" -H 'content-type: application/json' -d '{"payload":{}}')"
check "u1 llm.providers" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_U1" -X POST "$ORIGIN/api/llm.providers" -H 'content-type: application/json' -d '{"payload":{}}')"

# -- instance mount shape: guard home layer + package link + grants file -----
[ -f "$ROOT/users/u1/dsh/cordis.patch.yml" ] \
  && check "guard bundle mounted as the home patch layer" "yes" "yes" \
  || check "guard bundle mounted as the home patch layer" "yes" "no"
[ -f "$ROOT/users/u1/dsh/directory-grants.json" ] \
  && check "u1 grants file written before start" "yes" "yes" \
  || check "u1 grants file written before start" "yes" "no"
LINK="$ROOT/users/u1/dsh/profiles/node_modules/@deepseek-ai/dsh-directory-guard"
[ -L "$LINK" ] && check "guard package linked into profile" "yes" "yes" \
  || check "guard package linked into profile" "yes" "no"

# -- u2: parallel instance, isolation by process boundary ---------------------
check "u2 login" "302" "$(login "$JAR_U2" u2 init-pw-222)"
check "u2 password change" "302" "$(change_pw "$JAR_U2" u2-pw-22222)"
check "u2 index through proxy (after boot)" "200" "$(wait_ready "$JAR_U2")"
U1_PORT="$(sqlite3 "$ROOT/data/gateway.sqlite" "SELECT port FROM instances WHERE user_id=(SELECT id FROM users WHERE username='u1')")"
U2_PORT="$(sqlite3 "$ROOT/data/gateway.sqlite" "SELECT port FROM instances WHERE user_id=(SELECT id FROM users WHERE username='u2')")"
[ "$U1_PORT" != "$U2_PORT" ] && check "u1/u2 run separate instances" "yes" "yes" \
  || check "u1/u2 run separate instances" "yes" "no (both $U1_PORT)"

# -- WebSocket downlink through the proxy -------------------------------------
COOKIE_U1="$(awk '$6=="hgw_session"{print $7}' "$JAR_U1" | tail -1)"
WS_RESULT="$(node -e '
const WebSocket = require("ws")
const ws = new WebSocket(process.argv[1] + "/api/events.mux", { headers: { cookie: "hgw_session=" + process.argv[2], origin: process.argv[3] } })
const bail = setTimeout(() => { console.log("timeout"); process.exit(0) }, 8000)
ws.on("open", () => { clearTimeout(bail); console.log("open"); ws.close(); })
ws.on("error", (e) => { clearTimeout(bail); console.log("error:" + e.message); process.exit(0) })
' "ws://127.0.0.1:$PORT" "$COOKIE_U1" "$ORIGIN")"
check "u1 WebSocket events.mux upgrades through the proxy" "open" "$WS_RESULT"

# -- session hygiene: logout revokes; lockout after 5 failures ----------------
check "u1 logout" "302" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_U1" -H "Origin: $ORIGIN" -X POST "$ORIGIN/logout")"
check "u1 API rejected after logout" "401" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_U1" -X POST "$ORIGIN/api/session.list" -d '{}')"
for _ in 1 2 3 4 5; do login "$ROOT/x.jar" u2 wrong-pw >/dev/null; done
check "u2 locked after 5 failures" "429" "$(login "$ROOT/x.jar" u2 wrong-pw)"

echo
echo "== $PASS passed, $FAIL failed (log: $LOG, root kept for inspection: $ROOT)"
[ "$FAIL" = "0" ]
