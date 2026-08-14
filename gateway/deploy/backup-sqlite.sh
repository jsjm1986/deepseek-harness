#!/bin/bash
# Nightly gateway-database backup (cron: `0 3 * * * /srv/harness/gateway/deploy/backup-sqlite.sh`).
# Uses sqlite's online-backup command so a live gateway keeps serving, prunes
# to the newest 30 archives.
set -euo pipefail

DATA_DIR="${HGW_DATA_DIR:-/srv/harness/gateway-data}"
BACKUP_DIR="${HGW_BACKUP_DIR:-$DATA_DIR/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"
sqlite3 "$DATA_DIR/gateway.sqlite" ".backup '$BACKUP_DIR/gateway-$STAMP.sqlite'"
gzip "$BACKUP_DIR/gateway-$STAMP.sqlite"
ls -1t "$BACKUP_DIR"/gateway-*.sqlite.gz | tail -n +31 | xargs -r rm --
echo "backup written: $BACKUP_DIR/gateway-$STAMP.sqlite.gz"
