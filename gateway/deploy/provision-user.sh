#!/bin/bash
# Provision the Linux side of one harness user (idempotent, run as root):
# a per-user system account plus the owned directory layout the per-user
# systemd unit binds. The gateway's admin console creates the user row and
# directories; this script adds what needs root — the system account and
# ownership — and is safe to re-run.
#
# Usage: provision-user.sh <username> [users-root]
set -euo pipefail

USERNAME="${1:?usage: provision-user.sh <username> [users-root]}"
USERS_ROOT="${2:-/srv/harness/users}"
ACCOUNT="harness-$USERNAME"

case "$USERNAME" in
  *[!a-z0-9-]*|'') echo "invalid username: $USERNAME" >&2; exit 1 ;;
esac

if ! id -u "$ACCOUNT" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$ACCOUNT"
  echo "created system account $ACCOUNT"
fi

mkdir -p "$USERS_ROOT/$USERNAME/home" "$USERS_ROOT/$USERNAME/dsh"
chown -R "$ACCOUNT:$ACCOUNT" "$USERS_ROOT/$USERNAME"
chmod 750 "$USERS_ROOT/$USERNAME"
echo "provisioned $USERS_ROOT/$USERNAME for $ACCOUNT"
