#!/bin/bash
# Online logical backup for the local Docker PostgreSQL deployment.
set -euo pipefail
umask 077

cd "$(dirname "$0")"
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi
BACKUP_DIR="${HGW_POSTGRES_BACKUP_DIR:-$HOME/harness-postgres-backups}"
RETENTION="${HGW_POSTGRES_BACKUP_RETENTION:-30}"
case "$RETENTION" in
  ''|*[!0-9]*|0) echo 'HGW_POSTGRES_BACKUP_RETENTION must be a positive integer' >&2; exit 2 ;;
esac
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="harness-$STAMP.dump"
mkdir -p "$BACKUP_DIR"
TMP="$BACKUP_DIR/.$NAME.tmp.$$"
cleanup() { rm -f -- "$TMP"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

docker compose exec -T postgres pg_dump \
  --username harness_owner --dbname harness --format=custom --compress=9 \
  > "$TMP"
docker compose exec -T postgres pg_restore --list < "$TMP" >/dev/null
mv "$TMP" "$BACKUP_DIR/$NAME"

# Keep the newest N successful dumps. This loop is compatible with the
# Bash 3.2 shipped by macOS; every candidate comes from the fixed backup glob.
COUNT=0
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'harness-*.dump' -print | sort -r | while IFS= read -r FILE; do
  COUNT=$((COUNT + 1))
  if [ "$COUNT" -gt "$RETENTION" ]; then rm -- "$FILE"; fi
done
printf 'backup=%s\n' "$BACKUP_DIR/$NAME"
