#!/bin/bash
# AURION Update Server launcher. Lives in admin/ next to update-server/.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required." >&2
  exit 1
fi

mkdir -p update-server/data

# Creates .env on first run, and repairs one whose ADMIN_TOKEN is empty.
TOKEN="$(node update-server/ensure-env.js)"

echo
echo "  AURION Update Server"
echo "  --------------------"
echo "  panel   http://127.0.0.1:8898/admin/aurion-update-admin-x9k3"
echo "  token   $TOKEN"
echo

cd update-server
if [ ! -d node_modules/express ]; then
  echo "  Installing update-server packages..."
  npm install --no-audit --no-fund >/dev/null 2>&1 || true
fi
node src/index.js
