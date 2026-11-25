#!/usr/bin/env bash
#
# AURION on an Android phone, in one command.
#
#     bash scripts/start-termux.sh
#
# Why this is not just scripts/start.sh
# -------------------------------------
# Termux is not Linux as far as Python packaging is concerned. Its
# platform tag is aarch64-linux-android, while every prebuilt ARM wheel
# on PyPI is tagged manylinux_aarch64. pip refuses the mismatch, falls
# back to building from source, and then:
#
#   * numpy, pandas and scikit-learn each want a full compile,
#   * pydantic-core wants a Rust target triple rustup does not publish
#     for Android, so it fails outright,
#   * and Termux now ships Python 3.13, for which numpy 1.26.4 - the
#     version engine/requirements.txt pins, and the last one that is
#     CPU-safe for us - has no wheel at all.
#
# None of that is worked around. It is sidestepped: this script puts a
# Debian in front of it with proot-distro. Inside, the platform is
# glibc Linux again, every wheel installs in seconds, and Debian
# bookworm's Python 3.11 sits inside the supported 3.9-3.12 range.
#
# scikit-learn is not optional, before anyone tries trimming the
# requirements to make a native install fit: runtime/trader.py imports
# ai/engine.py, which imports ai/models.py, which imports sklearn at
# module level. No sklearn, no engine.
#
# What it does
# ------------
#   1. On Termux: installs proot-distro and Debian if missing, takes a
#      wake lock, then re-runs itself inside Debian with this checkout
#      bind-mounted - so there is one copy of the repo, not two.
#   2. Inside: installs apt packages, builds .venv, pip-installs
#      engine/requirements.txt, npm-installs the backend. All of it
#      skipped on later runs unless the dependency files changed.
#   3. Starts the engine, waits for /health, then starts the desk.
#
# Safe to run repeatedly. The slow first run is the only slow one.
#
# Options
#   --here        skip the Termux stage; set up and run in the current
#                 system. Use this on any glibc Linux, or if you are
#                 already inside the Debian.
#   --reinstall   force the dependency steps to run again.
#   --setup-only  install everything, start nothing.
#
# Environment
#   AURION_PORT          desk port, default 8080
#   AURION_ENGINE_PORT   engine port, default 18765
#   AURION_HOST          desk bind address, default 0.0.0.0
#   AURION_DISTRO        proot-distro name, default debian
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DISTRO="${AURION_DISTRO:-debian}"
GUEST_ROOT="/root/AURION"

HERE=0
REINSTALL=0
SETUP_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --here)       HERE=1 ;;
    --reinstall)  REINSTALL=1 ;;
    --setup-only) SETUP_ONLY=1 ;;
    -h|--help)    sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "[aurion] unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '[aurion] %s\n' "$*"; }
fail() { printf '[aurion] %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------
# Stage 1 - Termux. Build the Debian, then hand over to stage 2.
# ---------------------------------------------------------------------

# Termux and the Debian inside it are both aarch64 Linux, so uname will
# not separate them. $PREFIX under com.termux will, and /etc/os-release
# confirms it from the other side.
on_termux() {
  [ -n "${PREFIX:-}" ] && [ -d "${PREFIX}/bin" ] \
    && case "$PREFIX" in */com.termux/*) return 0 ;; esac
  return 1
}

if [ "$HERE" -eq 0 ] && on_termux; then
  say "Termux detected."
  say "Python packaging does not work natively here - setting up Debian instead."
  echo

  if ! command -v proot-distro >/dev/null 2>&1; then
    say "installing proot-distro"
    pkg install -y proot-distro
  fi

  if ! proot-distro list --installed 2>/dev/null | grep -qw "$DISTRO"; then
    say "installing $DISTRO (a few hundred MB, once)"
    proot-distro install "$DISTRO"
  fi

  # Android suspends processes once the screen goes off, which kills the
  # engine mid-trade. Released again on the way out.
  if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock || true
    trap 'termux-wake-unlock >/dev/null 2>&1 || true' EXIT
  else
    say "note: termux-api is not installed, so no wake lock."
    say "      Android may suspend AURION when the screen goes off."
    say "      pkg install termux-api  (and the Termux:API app) fixes it."
  fi

  inner="--here"
  [ "$REINSTALL"  -eq 1 ] && inner="$inner --reinstall"
  [ "$SETUP_ONLY" -eq 1 ] && inner="$inner --setup-only"

  say "entering $DISTRO"
  echo
  # The checkout is bound rather than copied: one repo, one git history,
  # and `git pull` from Termux is immediately live inside.
  exec proot-distro login "$DISTRO" \
    --bind "$ROOT:$GUEST_ROOT" \
    -- /bin/bash "$GUEST_ROOT/scripts/start-termux.sh" $inner
fi

# ---------------------------------------------------------------------
# Stage 2 - a glibc Linux. Install what is missing, then run.
# ---------------------------------------------------------------------

cd "$ROOT"

export PYTHONUNBUFFERED=1
export AURION_HOST="${AURION_HOST:-0.0.0.0}"
export AURION_PORT="${AURION_PORT:-8080}"
export AURION_DATA_DIR="${AURION_DATA_DIR:-$ROOT/data}"
ENGINE_PORT="${AURION_ENGINE_PORT:-18765}"
export AURION_ENGINE_PORT="$ENGINE_PORT"

LOGS="$AURION_DATA_DIR/logs"
mkdir -p "$LOGS" "$AURION_DATA_DIR/exports" "$AURION_DATA_DIR/uploads" \
         "$AURION_DATA_DIR/archive" engine/models
ENGINE_LOG="$LOGS/engine-start.log"

VENV="$ROOT/.venv"
# Kept inside the venv, not in data/: .venv/ is already ignored by git,
# and a stamp that outlived the environment it describes would claim
# dependencies were installed into something that no longer exists.
STAMP="$VENV/.aurion-setup-stamp"

apt_get() {
  if command -v sudo >/dev/null 2>&1 && [ "$(id -u)" -ne 0 ]; then
    sudo apt-get "$@"
  else
    apt-get "$@"
  fi
}

# --- apt packages -----------------------------------------------------
need_apt=""
command -v python3 >/dev/null 2>&1 || need_apt="$need_apt python3"
command -v node    >/dev/null 2>&1 || need_apt="$need_apt nodejs"
command -v npm     >/dev/null 2>&1 || need_apt="$need_apt npm"
command -v git     >/dev/null 2>&1 || need_apt="$need_apt git"
command -v curl    >/dev/null 2>&1 || need_apt="$need_apt curl"
python3 -c 'import venv, ensurepip' >/dev/null 2>&1 || need_apt="$need_apt python3-venv"

if [ -n "$need_apt" ]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    fail "missing:$need_apt - install them and run again."
  fi
  say "installing:$need_apt"
  apt_get update -qq
  # shellcheck disable=SC2086
  DEBIAN_FRONTEND=noninteractive apt_get install -y -qq $need_apt
fi

# --- the interpreter --------------------------------------------------
# numpy 1.26.4 is pinned because it is the last release with a wheel
# that does not require x86-64-v2, and it only publishes for CPython
# 3.9 to 3.12. 3.13 is the exact trap Termux walks into.
PY=""
for cand in python3.12 python3.11 python3.10 python3; do
  command -v "$cand" >/dev/null 2>&1 || continue
  if "$cand" -c 'import sys; sys.exit(0 if (3,9) <= sys.version_info < (3,13) else 1)' 2>/dev/null; then
    PY="$cand"; break
  fi
done
if [ -z "$PY" ]; then
  have="$(python3 -V 2>&1 || echo 'none')"
  fail "need CPython 3.9-3.12, found $have.
       numpy 1.26.4 publishes no wheel for 3.13+, so the engine cannot
       be installed against it. On Debian/Ubuntu:
         apt-get install -y python3.12 python3.12-venv
       then run this script again."
fi
say "python: $($PY -V) at $(command -v "$PY")"

# --- has anything changed since last time? ----------------------------
fingerprint() {
  cat engine/requirements.txt backend/package.json 2>/dev/null
  cat backend/package-lock.json 2>/dev/null
  "$PY" -V
}
want="$(fingerprint | sha256sum | cut -d' ' -f1)"
have="$(cat "$STAMP" 2>/dev/null || echo none)"

if [ "$REINSTALL" -eq 1 ] || [ "$want" != "$have" ] || [ ! -x "$VENV/bin/python" ]; then
  say "installing dependencies (first run takes a while on a phone)"

  [ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
  # shellcheck disable=SC1091
  . "$VENV/bin/activate"
  python -m pip install -q --upgrade pip
  say "pip: engine/requirements.txt"
  python -m pip install -q -r engine/requirements.txt

  say "npm: backend"
  ( cd backend && npm install --omit=dev --no-audit --no-fund )

  printf '%s' "$want" > "$STAMP"
  say "dependencies ready"
else
  # shellcheck disable=SC1091
  . "$VENV/bin/activate"
  say "dependencies already installed (--reinstall to redo)"
fi

if [ "$SETUP_ONLY" -eq 1 ]; then
  say "setup complete. Run without --setup-only to start."
  exit 0
fi

# --- run --------------------------------------------------------------
# The engine is started here rather than left to the backend's
# supervisor so that a failure prints its log instead of leaving the
# browser on "Waiting for the engine..." with nothing to act on. The
# supervisor checks whether the port is already held before starting
# anything, so it will not race this one.
say "starting engine on :$ENGINE_PORT"
python engine/main.py --host 127.0.0.1 --port "$ENGINE_PORT" >"$ENGINE_LOG" 2>&1 &
ENGINE_PID=$!

cleanup() {
  kill "${ENGINE_PID:-}" "${DESK_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Importing numpy, pandas and scikit-learn takes a few seconds on a
# desktop and the better part of a minute on a phone, so the budget is
# generous - but a dead process is detected immediately rather than
# waited out.
printf '[aurion] waiting for the engine'
ENGINE_UP=0
for _ in $(seq 1 180); do
  if curl -fsS -m 2 "http://127.0.0.1:${ENGINE_PORT}/health" >/dev/null 2>&1; then
    printf ' - online\n'
    ENGINE_UP=1
    break
  fi
  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then
    printf '\n'
    say "the engine exited during start-up. Its log:"
    echo "---------------------------------------------------------------"
    tail -n 40 "$ENGINE_LOG"
    echo "---------------------------------------------------------------"
    say "full log: $ENGINE_LOG"
    exit 1
  fi
  printf '.'
  sleep 1
done

if [ "$ENGINE_UP" -ne 1 ]; then
  printf '\n'
  say "the engine did not answer on :$ENGINE_PORT within 180s. Its log:"
  echo "---------------------------------------------------------------"
  tail -n 40 "$ENGINE_LOG"
  echo "---------------------------------------------------------------"
  exit 1
fi

say "starting desk on :$AURION_PORT"
node backend/src/index.js &
DESK_PID=$!

echo
say "AURION is up. Open it in the phone's browser:"
say "    http://127.0.0.1:${AURION_PORT}"
say "Stop with Ctrl-C."
echo
say "MetaTrader5's Python package is Windows-only, so there is no direct"
say "broker link on a phone. For live data, point an EA on a Windows box"
say "at this device: TCP 18766, or POST /v1/ea/ingest on port $AURION_PORT."
echo

wait
