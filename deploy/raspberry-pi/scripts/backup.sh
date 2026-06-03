#!/usr/bin/env bash
set -Eeuo pipefail

ETC_DIR="${POS_ETC_DIR:-/etc/pos-v2}"
BACKUP_DIR="${POS_BACKUP_DIR:-/var/backups/pos-v2}"
KEEP_DAYS="${POS_BACKUP_KEEP_DAYS:-14}"

if [[ ! -r "$ETC_DIR/backend.env" ]]; then
  echo "[backup] missing $ETC_DIR/backend.env" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ETC_DIR/backend.env"
set +a

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date +%Y%m%d_%H%M%S)"
out="$BACKUP_DIR/pos_v2_${stamp}.sql.gz"

echo "[backup] writing $out"
PGPASSWORD="${PGPASSWORD:-}" pg_dump \
  --host="${PGHOST:-127.0.0.1}" \
  --port="${PGPORT:-5432}" \
  --username="${PGUSER:-pos_v2_app}" \
  --dbname="${PGDATABASE:-pos_v2}" \
  --no-owner \
  --no-privileges \
  | gzip -9 > "$out"

chmod 600 "$out"
find "$BACKUP_DIR" -type f -name 'pos_v2_*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "[backup] done"
