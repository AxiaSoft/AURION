#!/bin/bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p update-server/data
if [ ! -f update-server/.env ]; then
  cp update-server/.env.example update-server/.env
  echo "Created update-server/.env - please edit ADMIN_TOKEN and ADMIN_PANEL_HASH"
fi
cd update-server
npm install --no-audit --no-fund >/dev/null 2>&1 || true
node src/index.js
