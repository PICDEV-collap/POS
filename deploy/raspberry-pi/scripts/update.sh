#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="${POS_APP_USER:-posv2}"
APP_GROUP="${POS_APP_GROUP:-posv2}"
INSTALL_DIR="${POS_INSTALL_DIR:-/opt/pos-v2}"
ETC_DIR="${POS_ETC_DIR:-/etc/pos-v2}"
DATA_DIR="${POS_DATA_DIR:-/var/lib/pos-v2}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

run_as_app() {
  sudo -u "$APP_USER" -H bash -lc "$*"
}

echo "[update] stopping services"
systemctl stop pos-v2-web pos-v2-backend || true

echo "[update] syncing project"
mkdir -p "$INSTALL_DIR" "$DATA_DIR/uploads"
if [[ "$(realpath "$REPO_ROOT")" != "$(realpath "$INSTALL_DIR")" ]]; then
  rsync -a --delete \
    --exclude='.git/' \
    --exclude='node_modules/' \
    --exclude='customer-web/.next/cache/' \
    --exclude='mobile/build/' \
    --exclude='deploy/mobile/' \
    --exclude='deploy/logs/' \
    --exclude='tools/' \
    --exclude='artifacts/' \
    --exclude='backend/.env' \
    --exclude='customer-web/.env.local' \
    --exclude='deploy/ngrok.yml' \
    --exclude='backend/uploads/' \
    "$REPO_ROOT/" "$INSTALL_DIR/"
fi

if [[ -d "$INSTALL_DIR/backend/uploads" && ! -L "$INSTALL_DIR/backend/uploads" ]]; then
  rsync -a "$INSTALL_DIR/backend/uploads/" "$DATA_DIR/uploads/" || true
  rm -rf "$INSTALL_DIR/backend/uploads"
fi
ln -sfn "$DATA_DIR/uploads" "$INSTALL_DIR/backend/uploads"
ln -sfn "$ETC_DIR/backend.env" "$INSTALL_DIR/backend/.env"
ln -sfn "$ETC_DIR/web.env" "$INSTALL_DIR/customer-web/.env.local"
chown -R "$APP_USER:$APP_GROUP" "$INSTALL_DIR" "$DATA_DIR"
chmod +x "$INSTALL_DIR/deploy/raspberry-pi/scripts/"*.sh

echo "[update] installing backend dependencies"
run_as_app "cd $(shell_quote "$INSTALL_DIR/backend") && npm ci --omit=dev"

echo "[update] building web app"
run_as_app "cd $(shell_quote "$INSTALL_DIR/customer-web") && npm ci && set -a && source $(shell_quote "$ETC_DIR/web.env") && set +a && npm run build && npm prune --omit=dev"

echo "[update] migrating database"
run_as_app "cd $(shell_quote "$INSTALL_DIR/backend") && npm run db:migrate"

echo "[update] restarting services"
systemctl daemon-reload
systemctl restart pos-v2-backend pos-v2-web nginx

"$INSTALL_DIR/deploy/raspberry-pi/scripts/healthcheck.sh"
echo "[update] done"
