#!/usr/bin/env bash
set -Eeuo pipefail

fail=0

check_url() {
  local name="$1"
  local url="$2"
  if curl -fsS --max-time 5 "$url" >/dev/null; then
    echo "[ok] $name $url"
  else
    echo "[fail] $name $url" >&2
    fail=1
  fi
}

check_service() {
  local name="$1"
  if systemctl is-active --quiet "$name"; then
    echo "[ok] service $name"
  else
    echo "[fail] service $name" >&2
    fail=1
  fi
}

check_service postgresql
check_service pos-v2-backend
check_service pos-v2-web
check_service nginx
check_url backend "http://127.0.0.1:4000/api/health"
check_url web "http://127.0.0.1:3000/"
check_url nginx "http://127.0.0.1/"

exit "$fail"
