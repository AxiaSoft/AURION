#!/usr/bin/env bash
# AURION - standalone Telegram admin panel (owner only, loopback only)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "Node.js is not installed."; exit 1; }
echo "Starting the AURION Telegram admin panel on http://127.0.0.1:8913"
exec node "$ROOT/admin/telegram-panel/server.js"
