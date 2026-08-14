#!/bin/bash
# Phase 1 acceptance (design doc §12, Task 11 + B4 runtime half), Mac dev form.
# Boots a fresh gateway against an explicitly disposable PostgreSQL database,
# drives two users end to end
# through curl/node, and prints PASS/FAIL per check. Requires the repo's Node
# (see .nvmrc) on PATH; no API key needed (no model turns are driven).
set -u
cd "$(dirname "$0")/.."

PORT="${ACCEPT_PORT:-18899}"
INSTANCE_PORT_BASE="${ACCEPT_INSTANCE_PORT_BASE:-$((PORT + 10000))}"
ORIGIN="http://127.0.0.1:$PORT"
ROOT="$(mktemp -d /tmp/hgw-accept-XXXXXX)"
LOG="$ROOT/gateway.log"
JAR_ADMIN="$ROOT/admin.jar"; JAR_U1="$ROOT/u1.jar"; JAR_U2="$ROOT/u2.jar"
PASS=0; FAIL=0
DATABASE_URL="${HGW_ACCEPT_DATABASE_URL:-}"

if [ -z "$DATABASE_URL" ]; then
  echo "FATAL: HGW_ACCEPT_DATABASE_URL must name a disposable database ending in _test, _accept, or _acceptance" >&2
  exit 1
fi

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1"
  else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected $2, got $3)"; fi
}

echo "== scratch root: $ROOT"
HGW_DATABASE_URL="$DATABASE_URL" npx tsx scripts/prepare-acceptance-postgres.ts || exit 1
# Instance policy plugins are mounted by package name; plain Node loads their built lib/.
if [ ! -f ../plugins/dsh-directory-guard/lib/index.js ]; then
  (cd ../plugins/dsh-directory-guard && npx tsc -p tsconfig.build.json)
fi
if [ ! -f ../plugins/dsh-model-governance/lib/index.js ]; then
  (cd ../plugins/dsh-model-governance && npx tsc -p tsconfig.build.json)
fi
HGW_DATABASE_URL="$DATABASE_URL" HGW_ORGANIZATION_SLUG=acceptance HGW_COMPUTE_NODE_NAME=local \
  HGW_PORT="$PORT" HGW_INSTANCE_PORT_BASE="$INSTANCE_PORT_BASE" HGW_USERS_ROOT="$ROOT/users" \
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
check "create u1" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -H "Origin: $ORIGIN" -H 'content-type: application/json' -X POST -d '{"username":"u1","password":"init-pw-111","role":"user"}' "$ORIGIN/admin/api/users")"
check "create u2" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -H "Origin: $ORIGIN" -H 'content-type: application/json' -X POST -d '{"username":"u2","password":"init-pw-222","role":"user"}' "$ORIGIN/admin/api/users")"
check "register governed model" "204" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -H "Origin: $ORIGIN" -H 'content-type: application/json' -X PUT -d '{"provider":"deepseek-official","model":"deepseek-chat","displayName":"DeepSeek Chat","enabled":true,"adminAllowed":true,"userAllowed":false,"inputMicrosPerMillion":1000000,"outputMicrosPerMillion":2000000,"cacheReadMicrosPerMillion":500000,"cacheWriteMicrosPerMillion":0}' "$ORIGIN/admin/api/models")"
check "set role usage quota" "204" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" -H "Origin: $ORIGIN" -H 'content-type: application/json' -X PUT -d '{"subjectType":"role","subjectId":"user","tokenLimit":1000,"companyCostMicrosLimit":10000000}' "$ORIGIN/admin/api/quotas")"

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
  && check "policy bundles mounted as the home patch layer" "yes" "yes" \
  || check "policy bundles mounted as the home patch layer" "yes" "no"
grep -q '@deepseek-ai/dsh-model-governance' "$ROOT/users/u1/dsh/cordis.patch.yml" \
  && check "home patch includes mandatory model governance" "yes" "yes" \
  || check "home patch includes mandatory model governance" "yes" "no"
[ -f "$ROOT/users/u1/dsh/directory-grants.json" ] \
  && check "u1 grants file written before start" "yes" "yes" \
  || check "u1 grants file written before start" "yes" "no"
MODULES="$ROOT/users/u1/dsh/profiles/node_modules/@deepseek-ai"
[ -L "$MODULES/dsh-directory-guard" ] && check "guard package linked into profile" "yes" "yes" \
  || check "guard package linked into profile" "yes" "no"
[ -L "$MODULES/dsh-model-governance" ] && check "governance package linked into profile" "yes" "yes" \
  || check "governance package linked into profile" "yes" "no"
POLICY="$ROOT/users/u1/dsh/model-governance.json"
[ -f "$POLICY" ] && check "u1 model policy projected before start" "yes" "yes" \
  || check "u1 model policy projected before start" "yes" "no"
POLICY_MODE="$(stat -f '%Lp' "$POLICY" 2>/dev/null || stat -c '%a' "$POLICY" 2>/dev/null || true)"
check "u1 model policy is private" "600" "$POLICY_MODE"
POLICY_ALLOWED="$(node -e 'const p=require(process.argv[1]); const m=p.models.find(x=>x.provider==="deepseek-official"&&x.model==="deepseek-chat"); process.stdout.write(String(m?.allowed))' "$POLICY")"
check "u1 role policy denies registered model" "false" "$POLICY_ALLOWED"
check "u1 own usage summary reachable" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_U1" "$ORIGIN/account/api/usage")"
TOKEN="$(node -e 'process.stdout.write(require(process.argv[1]).intakeToken)' "$POLICY")"
NOW_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
INTAKE_PORT=$((PORT+1))
INTAKE_BODY="{\"eventId\":\"accept-smoke-1\",\"occurredAt\":$NOW_MS,\"provider\":\"deepseek-official\",\"model\":\"deepseek-chat\",\"purpose\":\"assistant\",\"credentialSource\":\"user-env\",\"credentialClass\":\"company\",\"status\":\"succeeded\",\"usage\":{\"inputTokens\":1000,\"outputTokens\":0}}"
check "authenticated usage intake accepts event" "200" "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "$INTAKE_BODY" "http://127.0.0.1:$INTAKE_PORT/usage")"
USAGE_JSON="$(curl -s -b "$JAR_U1" "$ORIGIN/account/api/usage")"
USAGE_CALLS="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).calls))' "$USAGE_JSON")"
USAGE_TOKENS="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).totalTokens))' "$USAGE_JSON")"
check "usage ledger records one call" "1" "$USAGE_CALLS"
check "usage ledger records token buckets" "1000" "$USAGE_TOKENS"
USAGE_ALERTS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).alerts.map(a=>`${a.metric}:${a.threshold}`).join(","))' "$USAGE_JSON")"
check "usage ledger emits durable 80/100 alerts" "tokens:80,tokens:100" "$USAGE_ALERTS"
check "admin usage summary reachable" "200" "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR_ADMIN" "$ORIGIN/admin/api/usage")"

# -- u2: parallel instance, isolation by process boundary ---------------------
check "u2 login" "302" "$(login "$JAR_U2" u2 init-pw-222)"
check "u2 password change" "302" "$(change_pw "$JAR_U2" u2-pw-22222)"
check "u2 index through proxy (after boot)" "200" "$(wait_ready "$JAR_U2")"
USERS_JSON="$(curl -s -b "$JAR_ADMIN" "$ORIGIN/admin/api/users")"
U1_PORT="$(node -e 'const u=JSON.parse(process.argv[1]).find(x=>x.username==="u1"); process.stdout.write(String(u?.port??""))' "$USERS_JSON")"
U2_PORT="$(node -e 'const u=JSON.parse(process.argv[1]).find(x=>x.username==="u2"); process.stdout.write(String(u?.port??""))' "$USERS_JSON")"
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
