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
#   * and pydantic-core wants a Rust target triple rustup does not
#     publish for Android, so it fails outright.
#
# None of that is worked around. It is sidestepped: this script puts a
# Debian in front of it with proot-distro. Inside, the platform is
# glibc Linux again and every wheel installs in seconds, whichever
# Python that Debian happens to ship - there is no upper version bound
# here any more, because engine/requirements.txt now picks NumPy by
# architecture rather than capping the interpreter for everyone.
#
# scikit-learn is not optional, before anyone tries trimming the
# requirements to make a native install fit: runtime/trader.py imports
# ai/engine.py, which imports ai/models.py, which imports sklearn at
# module level. No sklearn, no engine.
#
# The repository may live on shared storage - /storage/emulated/0,
# where a file manager can see it. The environment may not: that mount
# has no exec bit, no symlinks and no SQLite locking worth the name, so
# the venv, node_modules and the data tree are moved to the distro's
# own filesystem. The code stays where you put it.
#
# What it does
# ------------
#   1. On Termux: installs proot-distro and Debian if missing, takes a
#      wake lock, then re-runs itself inside Debian with this checkout
#      bind-mounted - so there is one copy of the repo, not two.
#   2. Inside: installs apt packages, builds the venv, pip-installs
#      engine/requirements.txt, npm-installs the backend. All of it
#      skipped on later runs unless the dependency files changed.
#   3. Starts the engine, waits for /health, starts the desk, waits for
#      that too, then tells you where to open it.
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

  # Asked of the filesystem, not of `proot-distro list --installed`.
  # Parsing that output was a bug: its format varies between versions,
  # so on a machine that already had Debian the grep found nothing,
  # the script tried to install it again, and proot-distro exited with
  # "container 'debian' already exists" - taking the whole run with it
  # under set -e. The rootfs directory is the thing that is actually
  # true, and the install is tolerant now in case the layout moves.
  ROOTFS="$PREFIX/var/lib/proot-distro/installed-rootfs/$DISTRO"
  if [ ! -d "$ROOTFS" ]; then
    say "installing $DISTRO (a few hundred MB, once)"
    proot-distro install "$DISTRO" || true
  fi
  if [ ! -d "$ROOTFS" ] \
     && ! proot-distro login "$DISTRO" -- /bin/true >/dev/null 2>&1; then
    fail "could not install or reach the '$DISTRO' container.
       proot-distro list            shows what is available
       proot-distro remove $DISTRO  then re-run, to start clean"
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
ENGINE_PORT="${AURION_ENGINE_PORT:-18765}"
export AURION_ENGINE_PORT="$ENGINE_PORT"

# --- can this directory hold a working installation? ------------------
#
# Android's shared storage - /storage/emulated/0, what a file manager
# calls "Internal storage" - is a FUSE layer, not a filesystem. It
# cannot store a symlink, it ignores the executable bit, and its
# locking is not what SQLite expects. Keeping a repository there is
# perfectly fine and is what anyone who wants to see their files from
# the phone will do. Installing *into* it is not:
#
#   * python -m venv links or copies an interpreter and then runs it,
#     which needs both symlinks and the exec bit;
#   * npm writes symlinks into node_modules/.bin;
#   * the engine's SQLite databases want real locking.
#
# So the rule is: the code may live on shared storage, everything the
# machine has to execute or lock moves to the distro's own filesystem.
# Decided by trying it rather than by matching the path, because the
# question is what this mount can do, not what it is called.
can_install_into() {
  local d="$1" t
  t="$d/.aurion-probe.$$"
  rm -rf "$t" 2>/dev/null || true
  mkdir -p "$t" 2>/dev/null || return 1
  if ! printf '#!/bin/sh\nexit 7\n' > "$t/run" 2>/dev/null \
     || ! chmod +x "$t/run" 2>/dev/null \
     || ! ln -s run "$t/link" 2>/dev/null; then
    rm -rf "$t" 2>/dev/null || true
    return 1
  fi
  "$t/run" >/dev/null 2>&1
  local rc=$?
  rm -rf "$t" 2>/dev/null || true
  [ "$rc" -eq 7 ]
}

WORK="$ROOT"
if can_install_into "$ROOT"; then
  VENV="$ROOT/.venv"
  NPM_PREFIX="$ROOT/backend"
else
  WORK="$HOME/.aurion"
  say "this directory cannot hold an installation (no exec bit or no symlinks)."
  say "the code stays here; the environment goes to $WORK"

  # node resolves a bare import by walking up from the importing file,
  # so node_modules in the repository's PARENT is found by
  # backend/src/index.js without a symlink or a bind mount. Under the
  # Termux stage the repo is bound at /root/AURION, so the parent is
  # /root - the distro's own ext4.
  NPM_PREFIX="$(dirname "$ROOT")"
  if ! can_install_into "$NPM_PREFIX"; then
    fail "neither $ROOT nor its parent can hold an installation.
       Node finds its libraries by walking up from the file that
       imports them, so there has to be one usable directory above
       the repository. Clone or bind the repository somewhere under
       the distro's home instead - $HOME - and run this again."
  fi
  mkdir -p "$WORK"
  VENV="$WORK/venv"
  # SQLite over FUSE is the other half of the same problem, so the
  # runtime tree follows. Override AURION_DATA_DIR if you would rather
  # have it somewhere visible to the phone and accept the risk.
  export AURION_DATA_DIR="${AURION_DATA_DIR:-$WORK/data}"
fi
export AURION_DATA_DIR="${AURION_DATA_DIR:-$ROOT/data}"

LOGS="$AURION_DATA_DIR/logs"
mkdir -p "$LOGS" "$AURION_DATA_DIR/exports" "$AURION_DATA_DIR/uploads" \
         "$AURION_DATA_DIR/archive" engine/models 2>/dev/null || true
ENGINE_LOG="$LOGS/engine-start.log"

# Kept beside the environment it describes, never in the repository: a
# stamp that outlived its venv would claim dependencies were installed
# into something that no longer exists, and on shared storage the
# repository is the one place that cannot hold the venv anyway.
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
# The newest one on the machine wins, and there is no upper bound.
#
# This used to refuse anything past 3.12, which is why a phone could
# not run AURION at all: the distribution that ships 3.13 is exactly
# the one a current Debian or Ubuntu gives you. The limit was a proxy
# for NumPy's x86-64-v2 baseline, which is an x86 problem;
# engine/requirements.txt now says so with environment markers, so
# every architecture gets a set that installs. Nothing here needs to
# know the rule any more - it only has to pick an interpreter.
#
# The named candidates are a preference order, not a whitelist: plain
# python3 is tried too, so a release newer than anything listed here
# is still found and still used.
PY=""
PYV=0
for cand in python3 python3.15 python3.14 python3.13 python3.12 python3.11 python3.10 python3.9; do
  command -v "$cand" >/dev/null 2>&1 || continue
  v="$("$cand" -c 'import sys; print(sys.version_info[0] * 100 + sys.version_info[1])' 2>/dev/null)" || continue
  case "$v" in ''|*[!0-9]*) continue ;; esac
  [ "$v" -ge 309 ] || continue
  if [ "$v" -gt "$PYV" ]; then PYV="$v"; PY="$cand"; fi
done
if [ -z "$PY" ]; then
  have="$(python3 -V 2>&1 || echo 'none')"
  fail "need CPython 3.9 or newer, found $have.
       On Debian/Ubuntu:  apt-get install -y python3 python3-venv"
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
  # Installed from a copy of the backend's manifest so npm writes
  # node_modules into NPM_PREFIX. When that is backend/ this is the
  # ordinary install; when the repository is on shared storage it is
  # the parent directory, which node searches anyway.
  if [ "$NPM_PREFIX" = "$ROOT/backend" ]; then
    ( cd backend && npm install --omit=dev --no-audit --no-fund )
  else
    say "npm: installing into $NPM_PREFIX (shared storage cannot hold node_modules)"
    cp backend/package.json "$NPM_PREFIX/package.json"
    [ -f backend/package-lock.json ] && cp backend/package-lock.json "$NPM_PREFIX/package-lock.json"
    ( cd "$NPM_PREFIX" && npm install --omit=dev --no-audit --no-fund )
  fi

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

# The engine is waited for, so the desk is too. It printed "AURION is
# up" the moment node was spawned, which on a phone is several seconds
# before anything answers - long enough to open the address, get a
# connection refused, and conclude it is broken.
printf '[aurion] waiting for the desk'
for _ in $(seq 1 60); do
  if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:${AURION_PORT}/" 2>/dev/null; then
    printf ' - online\n'
    break
  fi
  if ! kill -0 "$DESK_PID" 2>/dev/null; then
    printf '\n'
    fail "the desk exited during start-up. Run it directly to see why:
       node backend/src/index.js"
  fi
  printf '.'
  sleep 1
done

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
