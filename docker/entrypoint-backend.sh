#!/bin/sh
set -eu

echo "[entrypoint] applying database migrations..."
node scripts/migrate.js

echo "[entrypoint] starting backend on ${LISTEN_HOST:-0.0.0.0}:${PORT:-4000}"
exec node src/server.js
