#!/bin/bash
# Restore one custom-format dump into a disposable database and verify schema.
set -euo pipefail
if [ "$#" -ne 1 ]; then echo "usage: $0 /absolute/path/harness-*.dump" >&2; exit 2; fi
DUMP="$1"
[ -f "$DUMP" ] || { echo "dump not found: $DUMP" >&2; exit 2; }
cd "$(dirname "$0")"
DB="harness_restore_check_$(date +%s)_$$"
cleanup() {
  docker compose exec -T postgres dropdb --username harness_owner --if-exists "$DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker compose exec -T postgres createdb --username harness_owner "$DB"
docker compose exec -T postgres pg_restore --username harness_owner --dbname "$DB" --clean --if-exists \
  < "$DUMP"
VERSION="$(docker compose exec -T postgres psql --username harness_owner --dbname "$DB" --tuples-only --no-align \
  --command 'SELECT max(version) FROM harness.schema_migrations')"
[ -n "$VERSION" ] || { echo 'restored database has no migration version' >&2; exit 1; }
printf 'restore_check=ok migration=%s\n' "$VERSION"
