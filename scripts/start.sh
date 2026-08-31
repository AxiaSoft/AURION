#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PYTHONUNBUFFERED=1
export AURION_HOST="${AURION_HOST:-0.0.0.0}"
export AURION_PORT="${AURION_PORT:-8080}"

python3 -m pip install -q -r engine/requirements.txt
if [[ "$(uname -s)" == "MINGW"* || "$(uname -s)" == "CYGWIN"* || "$(uname -s)" == "Windows_NT" ]]; then
  python3 -m pip install -q "MetaTrader5>=5.0.4874" || true
fi

( cd backend && npm install --omit=dev )

mkdir -p data/exports data/uploads data/archive engine/models

echo "[aurion] starting engine on :18765"
python3 engine/main.py --host 0.0.0.0 --port 18765 &
ENGINE_PID=$!
sleep 1
echo "[aurion] starting desk on :${AURION_PORT}"
node backend/src/index.js &
DESK_PID=$!

cleanup() {
  kill "$ENGINE_PID" "$DESK_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
wait
