#!/usr/bin/env bash
# Close AURION completely, then open it again.
#
# Asked for in these words: "after installing any update the
# application should shut down once and open again, not restart."
#
# The companion of relaunch-aurion.cmd, and the same reasoning:
# restart-aurion.sh leaves the Node desk process running and only
# brings the engine back, so an update that rewrote backend/src keeps
# serving the modules Node required at boot. Here everything stops -
# engine, bridge and desk - and the product is started from nothing.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p data/logs engine/models

# Settings first, before anything is stopped, or the shutdown loses
# whatever the trader applied in the last few seconds.
curl -fsS -m 5 -X POST "http://127.0.0.1:18765/v1/persist" >/dev/null 2>&1 || true
curl -fsS -m 5 -X POST "http://127.0.0.1:18765/v1/shutdown" >/dev/null 2>&1 || true
sleep 1

# The desk's own port (8080) is in this list, which is the one
# difference from restart-aurion.sh that matters.
for p in 8080 18765 18766; do
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${p}/tcp" >/dev/null 2>&1 || true
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti ":$p" | xargs -r kill -9 >/dev/null 2>&1 || true
  fi
done

# Wait for the ports to be genuinely free rather than sleeping a flat
# number of seconds and hoping. A desk started against a port the old
# process has not released yet exits immediately, which reads to the
# user as "the update closed my app and it never came back".
for _ in $(seq 1 20); do
  busy=""
  for p in 8080 18765; do
    if command -v lsof >/dev/null 2>&1 && lsof -ti ":$p" >/dev/null 2>&1; then busy="yes"; fi
  done
  [ -z "$busy" ] && break
  sleep 0.5
done

# Every cache of the version that just went, now that nothing is
# holding them open. Asked for with the relaunch: the app shuts down,
# the caches are cleared, and it comes back on the new build.
# purgeCaches in the updater does what it can from inside the running
# process; the browser cache cannot be deleted from there while the
# window is alive, so it is done here, in the gap.
rm -rf data/cache data/tmp data/update_tmp 2>/dev/null || true
rm -rf "$HOME/.config/AxiaSoft/AURION/Window/EBWebView/Default/Cache" \
       "$HOME/.config/AxiaSoft/AURION/Window/EBWebView/Default/Code Cache" \
       "$HOME/.config/AxiaSoft/AURION/Window/EBWebView/Default/Service Worker" 2>/dev/null || true
find engine -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true

# The owner pid must not survive this script.
#
# The window sets AURION_OWNER_PID for the desk it starts, so the desk
# can take the engine down if the window is killed. The variable reached
# here through the desk, and this script has just stopped everything the
# window owned - so handing it to the desk we are about to start would
# give that desk the pid of a process that is gone. It would look its
# owner up, find nothing, and shut itself down seconds after starting.
# Reported on Windows as "the update finishes and the app just closes";
# the same wiring exists here.
unset AURION_OWNER_PID
unset AURION_NO_BROWSER

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
