#!/bin/bash
# AURION admin panel — updates, Telegram and licences in one window.
# Reads the update token from admin/update-server/.env and the signing
# seed from admin/panel/seed.key; environment variables override both.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ is required." >&2
  exit 1
fi

if [ ! -f update-server/.env ]; then
  echo "  admin/update-server/.env does not exist yet, so the Updates tab"
  echo "  will have no token. Run ./start-update-server.sh once."
fi

exec node panel/server.js
