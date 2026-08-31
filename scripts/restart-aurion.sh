#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p data/logs engine/models
# Flush dashboard settings (config + runtime-state + settings-backup) before
# anything is stopped, so a restart never loses what the user applied.
curl -fsS -m 5 -X POST "http://127.0.0.1:18765/v1/persist" >/dev/null 2>&1 || true
curl -fsS -m 5 -X POST "http://127.0.0.1:18765/v1/shutdown" >/dev/null 2>&1 || true
sleep 1
for p in 8080 18765 18766; do
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${p}/tcp" >/dev/null 2>&1 || true
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti ":$p" | xargs -r kill -9 >/dev/null 2>&1 || true
  fi
done
sleep 1
PY="${AURION_PYTHON:-}"
if [ -z "$PY" ]; then
  if command -v python3 >/dev/null 2>&1; then PY=python3
  else PY=python
  fi
fi
nohup "$PY" engine/main.py --host 127.0.0.1 --port 18765 >> data/logs/engine.log 2>&1 &
sleep 2
cd backend
nohup node src/index.js >> ../data/logs/desk.log 2>&1 &
exit 0
