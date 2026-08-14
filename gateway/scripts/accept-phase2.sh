#!/bin/bash
# Phase 2 acceptance (design doc §12): kernel-level directory confinement,
# verified from INSIDE a running instance's mount namespace. Linux + root only
# (nsenter). Run after the gateway (HGW_LAUNCHER=systemd) has started the
# user's instance, e.g. by logging in once through the browser.
#
# Usage: accept-phase2.sh <username> <other-username> [ro-grant-path] [rw-grant-path]
#   <username>        the instance under test (unit harness-<username>)
#   <other-username>  a second user whose directories must be invisible
#   [ro-grant-path]   a directory granted read-only to <username>
#   [rw-grant-path]   a directory granted read-write to <username>
set -u

USERNAME="${1:?usage: accept-phase2.sh <username> <other-username> [ro-path] [rw-path]}"
OTHER="${2:?need a second username}"
RO_PATH="${3:-}"
RW_PATH="${4:-}"
USERS_ROOT="${HGW_USERS_ROOT:-/srv/harness/users}"
UNIT="harness-$USERNAME.service"
PASS=0; FAIL=0

check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1"
  else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected $2, got $3)"; fi
}

PID="$(systemctl show -p MainPID --value "$UNIT")"
[ -n "$PID" ] && [ "$PID" != "0" ] || { echo "FATAL: $UNIT is not running (log in once to start it)"; exit 1; }
in_ns() { nsenter -t "$PID" -m -p -- "$@" 2>&1; }

# 1. The other user's directories do not exist inside this namespace.
in_ns test -e "$USERS_ROOT/$OTHER" && check "peer user dir invisible" "absent" "present" \
  || check "peer user dir invisible" "absent" "absent"

# 2. Own home is writable.
in_ns touch "$USERS_ROOT/$USERNAME/home/.phase2-probe" >/dev/null \
  && check "own home writable" "yes" "yes" || check "own home writable" "yes" "no"
in_ns rm -f "$USERS_ROOT/$USERNAME/home/.phase2-probe" >/dev/null 2>&1

# 3. System paths are read-only (ProtectSystem=strict).
in_ns touch /usr/bin/.phase2-probe >/dev/null 2>&1 \
  && check "system paths read-only" "denied" "written" || check "system paths read-only" "denied" "denied"

# 4. Read-only grant: readable, not writable.
if [ -n "$RO_PATH" ]; then
  in_ns ls "$RO_PATH" >/dev/null 2>&1 \
    && check "ro grant readable" "yes" "yes" || check "ro grant readable" "yes" "no"
  in_ns touch "$RO_PATH/.phase2-probe" >/dev/null 2>&1 \
    && check "ro grant rejects writes" "denied" "written" || check "ro grant rejects writes" "denied" "denied"
fi

# 5. Read-write grant: writable.
if [ -n "$RW_PATH" ]; then
  in_ns touch "$RW_PATH/.phase2-probe" >/dev/null 2>&1 \
    && check "rw grant writable" "yes" "yes" || check "rw grant writable" "yes" "no"
  in_ns rm -f "$RW_PATH/.phase2-probe" >/dev/null 2>&1
fi

# 6. Ungranted host area invisible or unwritable (probe /root).
in_ns test -e /root/.bashrc >/dev/null 2>&1 \
  && check "host /root hidden (ProtectHome)" "hidden" "visible" \
  || check "host /root hidden (ProtectHome)" "hidden" "hidden"

echo
echo "== $PASS passed, $FAIL failed  (unit: $UNIT, pid $PID)"
echo "Repeat after switching the session to danger-full-access to confirm the kernel boundary holds."
[ "$FAIL" = "0" ]
