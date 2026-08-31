#!/bin/bash
# AURION Update Server launcher. Lives in admin/ next to update-server/.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

mkdir -p update-server/data
if [ ! -f update-server/.env ]; then
  if [ -f update-server/.env.example ]; then
    cp update-server/.env.example update-server/.env
    echo "Created update-server/.env - please edit ADMIN_TOKEN and ADMIN_PANEL_HASH"
  else
    echo "WARNING: update-server/.env is missing and no .env.example was found."
    echo "         The admin API stays disabled until ADMIN_TOKEN is set."
  fi
fi

cd update-server
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required." >&2
  exit 1
fi
if [ ! -d node_modules/express ]; then
  npm install --no-audit --no-fund >/dev/null 2>&1 || true
fi
node src/index.js
