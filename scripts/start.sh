#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PYTHONUNBUFFERED=1
export AURION_HOST="${AURION_HOST:-0.0.0.0}"
export AURION_PORT="${AURION_PORT:-8080}"

# Everything written at runtime. Override to keep the source tree clean.
export AURION_DATA_DIR="${AURION_DATA_DIR:-$ROOT/data}"

ENGINE_PORT="${AURION_ENGINE_PORT:-18765}"
LOGS="$AURION_DATA_DIR/logs"
mkdir -p "$LOGS" "$AURION_DATA_DIR/exports" "$AURION_DATA_DIR/uploads" "$AURION_DATA_DIR/archive" engine/models
ENGINE_LOG="$LOGS/engine-start.log"

python3 -m pip install -q -r engine/requirements.txt
if [[ "$(uname -s)" == "MINGW"* || "$(uname -s)" == "CYGWIN"* || "$(uname -s)" == "Windows_NT" ]]; then
  python3 -m pip install -q "MetaTrader5>=5.0.4874" || true
fi

( cd backend && npm install --omit=dev )

echo "[aurion] starting engine on :${ENGINE_PORT}"
python3 engine/main.py --host 127.0.0.1 --port "$ENGINE_PORT" >"$ENGINE_LOG" 2>&1 &
ENGINE_PID=$!

cleanup() {
  kill "$ENGINE_PID" "${DESK_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Importing numpy, pandas and scikit-learn takes several seconds, and the
# engine may also fail outright -- wrong Python, missing wheel, port already
# taken. Starting the desk before knowing which it is leaves the browser on
# "Waiting for the engine..." with nothing to act on, so wait for the health
# endpoint and say exactly what happened if it never answers.
echo -n "[aurion] waiting for the engine"
for _ in $(seq 1 120); do
  if curl -fsS -m 2 "http://127.0.0.1:${ENGINE_PORT}/health" >/dev/null 2>&1; then
    echo " — online"
    ENGINE_UP=1
    break
  fi
  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
    echo
    echo "[aurion] the engine exited during start-up. Its log:"
    echo "---------------------------------------------------------------"
    tail -n 40 "$ENGINE_LOG"
    echo "---------------------------------------------------------------"
    echo "[aurion] full log: $ENGINE_LOG"
    exit 1
  fi
  echo -n "."
  sleep 1
done

if [[ "${ENGINE_UP:-0}" != "1" ]]; then
  echo
  echo "[aurion] the engine did not answer on :${ENGINE_PORT} within 120s. Its log:"
  echo "---------------------------------------------------------------"
  tail -n 40 "$ENGINE_LOG"
  echo "---------------------------------------------------------------"
  exit 1
fi

echo "[aurion] starting desk on :${AURION_PORT}"
node backend/src/index.js &
DESK_PID=$!

echo "[aurion] desk: http://127.0.0.1:${AURION_PORT}"
wait
