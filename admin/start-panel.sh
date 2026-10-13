#!/usr/bin/env bash
# AURION admin panel — see start-panel.cmd for the explanation.
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js 18+ is required."; exit 1; }

[ -n "${AURION_KEY_PRIVATE_HEX:-}" ] || cat <<'MSG'

  AURION_KEY_PRIVATE_HEX is not set, so the Licences tab cannot mint.
  Generate a seed once:  python3 admin/new-seed.py
  Then export it before running this.

MSG

[ -n "${AURION_UPDATE_TOKEN:-}" ] || echo "  AURION_UPDATE_TOKEN is not set — the Updates tab will say so."
exec node panel/server.js
