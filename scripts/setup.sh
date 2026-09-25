#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
python3 -m pip install -r engine/requirements.txt
( cd backend && npm install )
mkdir -p data/exports data/uploads data/archive engine/models
echo "AURION setup complete. Run scripts/start.sh"
