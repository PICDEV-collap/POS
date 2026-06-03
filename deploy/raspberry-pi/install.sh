#!/usr/bin/env bash
set -Eeuo pipefail

APP_NAME="pos-v2"
APP_USER="${POS_APP_USER:-posv2}"
APP_GROUP="${POS_APP_GROUP:-posv2}"
INSTALL_DIR="${POS_INSTALL_DIR:-/opt/pos-v2}"
ETC_DIR="${POS_ETC_DIR:-/etc/pos-v2}"
DATA_DIR="${POS_DATA_DIR:-/var/lib/pos-v2}"
LOG_DIR="${POS_LOG_DIR:-/var/log/pos-v2}"
BACKUP_DIR="${POS_BACKUP_DIR:-/var/backups/pos-v2}"
DB_NAME="${POS_DB_NAME:-pos_v2}"
DB_USER="${POS_DB_USER:-pos_v2_app}"
NODE_MAJOR="${POS_NODE_MAJOR:-20}"
INTERACTIVE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive) INTERACTIVE=0; shift ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    --shop-name) POS_SHOP_NAME="$2"; shift 2 ;;
    --admin-user) POS_ADMIN_USER="$2"; shift 2 ;;
    --admin-password) POS_ADMIN_PASSWORD="$2"; shift 2 ;;
    --printer-host) POS_PRINTER_HOST="$2"; shift 2 ;;
    --public-base-url) POS_PUBLIC_BASE_URL="$2"; shift 2 ;;
    --lan-ip) POS_LAN_IP="$2"; shift 2 ;;
    -h|--help)
      cat <<'HELP'
POS V2 Raspberry Pi installer

Usage:
  sudo bash deploy/raspberry-pi/install.sh
  sudo POS_SHOP_NAME="My Shop" POS_ADMIN_PASSWORD="..." bash deploy/raspberry-pi/install.sh --non-interactive

Environment:
  POS_SHOP_NAME, POS_ADMIN_USER, POS_ADMIN_PASSWORD
  POS_PRINTER_HOST, POS_PUBLIC_BASE_URL, POS_LAN_IP
  POS_DB_NAME, POS_DB_USER, POS_DB_PASSWORD
HELP
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo -E bash "$0" "$@"
fi

mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/install-$(date +%Y%m%d_%H%M%S).log") 2>&1

fail() { echo "[install] ERROR: $*" >&2; exit 1; }
info() { echo "[install] $*"; }

shell_quote() {
  printf "'%s'" "$(printf "%s" "$1" | sed "s/'/'\\\\''/g")"
}

sql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

require_db_identifier() {
  local value="$1"
  local name="$2"
  [[ "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || fail "$name must be a PostgreSQL-safe identifier"
}

detect_lan_ip() {
  if [[ -n "${POS_LAN_IP:-}" ]]; then
    echo "$POS_LAN_IP"
    return
  fi
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [[ -z "$ip" ]]; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
  fi
  [[ -n "$ip" ]] || ip="127.0.0.1"
  echo "$ip"
}

random_secret() {
  openssl rand -hex 32
}

random_password() {
  openssl rand -hex 12
}

run_as_app() {
  sudo -u "$APP_USER" -H bash -lc "$*"
}

prompt_defaults() {
  SHOP_NAME="${POS_SHOP_NAME:-POS V2}"
  ADMIN_USER="${POS_ADMIN_USER:-admin}"
  ADMIN_FULL_NAME="${POS_ADMIN_FULL_NAME:-Administrator}"
  PRINTER_HOST="${POS_PRINTER_HOST:-}"
  LAN_IP="$(detect_lan_ip)"
  PUBLIC_BASE_URL="${POS_PUBLIC_BASE_URL:-http://$LAN_IP}"

  if [[ "$INTERACTIVE" == "1" ]]; then
    read -r -p "Shop name [$SHOP_NAME]: " answer || true
    SHOP_NAME="${answer:-$SHOP_NAME}"
    read -r -p "Admin username [$ADMIN_USER]: " answer || true
    ADMIN_USER="${answer:-$ADMIN_USER}"
    read -r -p "Printer host/IP (blank = disable real printer) [$PRINTER_HOST]: " answer || true
    PRINTER_HOST="${answer:-$PRINTER_HOST}"
    read -r -p "Public/LAN base URL [$PUBLIC_BASE_URL]: " answer || true
    PUBLIC_BASE_URL="${answer:-$PUBLIC_BASE_URL}"
  fi
  PUBLIC_BASE_URL="${PUBLIC_BASE_URL%/}"

  DB_PASSWORD="${POS_DB_PASSWORD:-$(random_password)}"
  JWT_SECRET="${POS_JWT_SECRET:-$(random_secret)}"
  ADMIN_PASSWORD="${POS_ADMIN_PASSWORD:-$(random_password)}"
}

install_packages() {
  info "installing OS packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y \
    ca-certificates curl git rsync openssl sudo \
    build-essential python3 make g++ pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    postgresql postgresql-contrib nginx avahi-daemon ufw jq \
    fonts-thai-tlwg fonts-noto-core

  local node_major=""
  if command -v node >/dev/null 2>&1; then
    node_major="$(node -p "process.versions.node.split('.')[0]" || true)"
  fi
  if [[ -z "$node_major" || "$node_major" -lt 18 ]]; then
    info "installing Node.js ${NODE_MAJOR}.x"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
  fi
}

create_user_and_dirs() {
  info "creating service user and directories"
  if ! getent group "$APP_GROUP" >/dev/null; then
    groupadd --system "$APP_GROUP"
  fi
  if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd --system --gid "$APP_GROUP" --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$APP_USER"
  fi

  mkdir -p "$INSTALL_DIR" "$ETC_DIR" "$DATA_DIR/uploads" "$LOG_DIR" "$BACKUP_DIR"
  chmod 750 "$ETC_DIR" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR"
  chown -R "$APP_USER:$APP_GROUP" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR"
}

sync_project() {
  info "syncing project to $INSTALL_DIR"
  local source_root target_root
  source_root="$(realpath "$REPO_ROOT")"
  target_root="$(realpath "$INSTALL_DIR")"

  if [[ "$source_root" != "$target_root" ]]; then
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
      "$source_root/" "$target_root/"
  fi

  if [[ -d "$INSTALL_DIR/backend/uploads" && ! -L "$INSTALL_DIR/backend/uploads" ]]; then
    rsync -a "$INSTALL_DIR/backend/uploads/" "$DATA_DIR/uploads/" || true
    rm -rf "$INSTALL_DIR/backend/uploads"
  fi
  ln -sfn "$DATA_DIR/uploads" "$INSTALL_DIR/backend/uploads"
  chown -R "$APP_USER:$APP_GROUP" "$INSTALL_DIR" "$DATA_DIR"
}

install_node_deps() {
  info "installing backend dependencies"
  run_as_app "cd $(shell_quote "$INSTALL_DIR/backend") && npm ci --omit=dev"

  info "generating web push keys"
  local vapid
  vapid="$(run_as_app "cd $(shell_quote "$INSTALL_DIR/backend") && node -e \"const webpush=require('web-push'); const k=webpush.generateVAPIDKeys(); console.log(k.publicKey + '\\n' + k.privateKey);\"")"
  VAPID_PUBLIC_KEY="$(printf "%s\n" "$vapid" | sed -n '1p')"
  VAPID_PRIVATE_KEY="$(printf "%s\n" "$vapid" | sed -n '2p')"
}

setup_database() {
  require_db_identifier "$DB_NAME" "POS_DB_NAME"
  require_db_identifier "$DB_USER" "POS_DB_USER"

  info "configuring PostgreSQL database"
  systemctl enable --now postgresql

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${DB_USER}'" | grep -qx "1"; then
    sudo -u postgres createuser "$DB_USER"
  fi
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c "ALTER ROLE \"$DB_USER\" WITH LOGIN PASSWORD '$(sql_quote "$DB_PASSWORD")';"

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -qx "1"; then
    sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  fi
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -c "ALTER DATABASE \"$DB_NAME\" OWNER TO \"$DB_USER\";"
}

write_env_files() {
  info "writing production env files"
  local cors
  cors="http://localhost,http://127.0.0.1,http://localhost:3000,http://127.0.0.1:3000,http://$LAN_IP,http://$LAN_IP:3000,$PUBLIC_BASE_URL"
  local printer_enabled="false"
  [[ -n "$PRINTER_HOST" ]] && printer_enabled="true"

  umask 077
  cat > "$ETC_DIR/backend.env" <<ENV
NODE_ENV=production
LISTEN_HOST=0.0.0.0
PORT=4000

PGHOST=127.0.0.1
PGPORT=5432
PGUSER=$DB_USER
PGPASSWORD=$DB_PASSWORD
PGDATABASE=$DB_NAME

JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=12h
BCRYPT_COST=12

CORS_ORIGINS=$cors
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
PUBLIC_ORDER_ALLOWED_CIDRS=
PUBLIC_ORDER_RATE_LIMIT_MAX=120

PRINTER_ENABLED=$printer_enabled
PRINTER_HOST=$PRINTER_HOST
PRINTER_PORT=${POS_PRINTER_PORT:-9100}
PRINTER_TIMEOUT_MS=${POS_PRINTER_TIMEOUT_MS:-3000}
PRINTER_THAI_CP=${POS_PRINTER_THAI_CP:-21}
PRINTER_WIDTH_CHARS=${POS_PRINTER_WIDTH_CHARS:-42}
PRINTER_RENDER_MODE=${POS_PRINTER_RENDER_MODE:-image}
PRINTER_WIDTH_PX=${POS_PRINTER_WIDTH_PX:-384}
PRINTER_FONT_PATH=${POS_PRINTER_FONT_PATH:-/usr/share/fonts/truetype/tlwg/Garuda.ttf}

VAPID_SUBJECT=${POS_VAPID_SUBJECT:-mailto:admin@pos-v2.local}
VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY

BONJOUR_ENABLED=true
ENV

  cat > "$ETC_DIR/web.env" <<ENV
NODE_ENV=production
PORT=3000
HOSTNAME=127.0.0.1
BACKEND_INTERNAL_URL=http://127.0.0.1:4000
NEXT_PUBLIC_API_BASE=
ENV

  chmod 640 "$ETC_DIR/backend.env" "$ETC_DIR/web.env"
  chown root:"$APP_GROUP" "$ETC_DIR/backend.env" "$ETC_DIR/web.env"
  ln -sfn "$ETC_DIR/backend.env" "$INSTALL_DIR/backend/.env"
  ln -sfn "$ETC_DIR/web.env" "$INSTALL_DIR/customer-web/.env.local"
}

build_web_and_migrate() {
  info "building web app"
  run_as_app "cd $(shell_quote "$INSTALL_DIR/customer-web") && npm ci && set -a && source $(shell_quote "$ETC_DIR/web.env") && set +a && npm run build && npm prune --omit=dev"

  info "running database migrations"
  run_as_app "cd $(shell_quote "$INSTALL_DIR/backend") && npm run db:migrate"

  info "creating/updating initial admin"
  run_as_app "cd $(shell_quote "$INSTALL_DIR/backend") && node scripts/create-admin.js $(shell_quote "$ADMIN_USER") $(shell_quote "$ADMIN_PASSWORD") $(shell_quote "$ADMIN_FULL_NAME")"

  cat > "$ETC_DIR/initial-admin.txt" <<EOF_CREDS
POS V2 initial admin
Generated: $(date -Is)
URL: $PUBLIC_BASE_URL/login
Username: $ADMIN_USER
Password: $ADMIN_PASSWORD
EOF_CREDS
  chmod 600 "$ETC_DIR/initial-admin.txt"
}

render_template() {
  local src="$1"
  local dst="$2"
  sed \
    -e "s#__APP_USER__#$APP_USER#g" \
    -e "s#__APP_GROUP__#$APP_GROUP#g" \
    -e "s#__INSTALL_DIR__#$INSTALL_DIR#g" \
    -e "s#__ETC_DIR__#$ETC_DIR#g" \
    -e "s#__DATA_DIR__#$DATA_DIR#g" \
    -e "s#__LOG_DIR__#$LOG_DIR#g" \
    -e "s#__BACKUP_DIR__#$BACKUP_DIR#g" \
    "$src" > "$dst"
}

install_services() {
  info "installing systemd and nginx services"
  chmod +x "$INSTALL_DIR/deploy/raspberry-pi/scripts/"*.sh

  render_template "$INSTALL_DIR/deploy/raspberry-pi/systemd/pos-v2-backend.service" /etc/systemd/system/pos-v2-backend.service
  render_template "$INSTALL_DIR/deploy/raspberry-pi/systemd/pos-v2-web.service" /etc/systemd/system/pos-v2-web.service
  render_template "$INSTALL_DIR/deploy/raspberry-pi/systemd/pos-v2-backup.service" /etc/systemd/system/pos-v2-backup.service
  render_template "$INSTALL_DIR/deploy/raspberry-pi/systemd/pos-v2-backup.timer" /etc/systemd/system/pos-v2-backup.timer

  cp "$INSTALL_DIR/deploy/raspberry-pi/nginx/pos-v2.conf" /etc/nginx/sites-available/pos-v2
  ln -sfn /etc/nginx/sites-available/pos-v2 /etc/nginx/sites-enabled/pos-v2
  rm -f /etc/nginx/sites-enabled/default
  nginx -t

  systemctl daemon-reload
  systemctl enable --now avahi-daemon
  systemctl enable --now pos-v2-backend pos-v2-web pos-v2-backup.timer nginx
  systemctl restart pos-v2-backend pos-v2-web nginx
}

configure_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -qw active; then
    info "opening firewall ports 80, 4000, and mDNS"
    ufw allow 80/tcp
    ufw allow 4000/tcp
    ufw allow 5353/udp
  fi
}

finish() {
  sleep 2
  "$INSTALL_DIR/deploy/raspberry-pi/scripts/healthcheck.sh"

  cat <<EOF_DONE

POS V2 Raspberry Pi deploy is ready.

Web/Admin/Kitchen:
  $PUBLIC_BASE_URL
  http://$LAN_IP

Backend for mobile app discovery/manual server:
  http://$LAN_IP:4000

Initial admin credential file:
  $ETC_DIR/initial-admin.txt

Service logs:
  journalctl -u pos-v2-backend -f
  journalctl -u pos-v2-web -f

Backups:
  $BACKUP_DIR
EOF_DONE
}

prompt_defaults
install_packages
create_user_and_dirs
sync_project
install_node_deps
setup_database
write_env_files
build_web_and_migrate
install_services
configure_firewall
finish
