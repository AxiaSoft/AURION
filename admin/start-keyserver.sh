#!/usr/bin/env bash
# AURION key server launcher (Linux/macOS). See start-keyserver.cmd for
# the Windows version and the explanation.
set -euo pipefail
cd "$(dirname "$0")/../store/keyserver"

command -v node >/dev/null || { echo "Node.js 18+ is required."; exit 1; }

if [ ! -f .env ]; then
  # Single quotes around the -e program. With double quotes the inner
  # "crypto" closed the shell's quote, node was handed a bare identifier
  # and died, and set -e took the launcher down with it.
  tok=$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')
  jwt=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
  cat > .env <<ENVEOF
PORT=8899
DATA_DIR=data
ADMIN_TOKEN=$tok
ADMIN_PANEL_HASH=aurion-keys-admin
JWT_SECRET=$jwt
AURION_KEY_PRIVATE_HEX=
ENVEOF
  echo
  echo "  Wrote store/keyserver/.env"
  echo "  Admin token: $tok"
  echo
  echo "  AURION_KEY_PRIVATE_HEX is empty on purpose. Generate the signing"
  echo "  seed once with:  python3 admin/new-seed.py"
  echo "  then paste the private line in. Until you do, no key can be minted."
  echo
fi

[ -d node_modules/express ] || npm install --no-audit --no-fund
echo
echo "  Point AURION at it with:"
echo "      node scripts/set-endpoints.mjs --store https://<your-address>"
echo "  (that writes config/aurion.factory.json, which is the copy the MSI ships.)"
echo
exec node src/index.js
