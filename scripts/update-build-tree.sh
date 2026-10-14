#!/usr/bin/env bash
# Bring the build tree up to date, and say what arrived.
# See update-build-tree.ps1 for why this exists.
set -euo pipefail

BRANCH="${1:-arena/01a10ba4-aurion}"
FORCE="${FORCE:-0}"

cd "$(dirname "$0")/.."
echo
echo "  AURION build tree update"
echo "  ------------------------"
echo "  folder  $(pwd)"
echo "  branch  $BRANCH"

[ -d .git ] || { echo "  not a git checkout"; exit 1; }

before=$(git rev-parse --short HEAD)
dirty=$(git status --porcelain | wc -l | tr -d ' ')

echo
echo "Before"
echo "  at $before  $(git log -1 --format=%s)"

if [ "$dirty" -gt 0 ] && [ "$FORCE" != "1" ]; then
  echo "  $dirty local change(s); stopping so none is lost."
  git status --porcelain | head -8 | sed 's/^/      /'
  echo "  Keep them: git stash    Discard: FORCE=1 $0"
  exit 2
fi

echo
echo "Fetching"
git fetch origin "$BRANCH"

target=$(git rev-parse --short FETCH_HEAD)
if [ "$target" = "$before" ] && [ "$dirty" -eq 0 ]; then
  echo
  echo "Already up to date at $target."
  exit 0
fi

echo
echo "Arriving"
git log --oneline "$before..FETCH_HEAD" | head -15 | sed 's/^/  /'

git reset --hard FETCH_HEAD >/dev/null
git branch --set-upstream-to="origin/$BRANCH" >/dev/null 2>&1 || true
after=$(git rev-parse --short HEAD)

# Remove what the branch removed. reset --hard drops tracked deletions;
# an untracked leftover from an older checkout survives it and keeps
# getting compiled. Costly or secret ignored paths are protected.
keep=(-e installer/vendor -e node_modules -e .venv_dev -e '*.env'
      -e panel.token -e seed.key -e 'data/')
stray=$(git clean -nd "${keep[@]}" | sed 's/^Would remove //')
echo
echo "Sweeping"
if [ -n "$stray" ]; then
  echo "$stray" | head -10 | sed 's/^/  /'
  git clean -fd "${keep[@]}" >/dev/null
  echo "  removed."
else
  echo "  nothing left over."
fi

if [ "${DEEP:-0}" = "1" ]; then
  rm -rf installer/build installer/output \
         installer/window/bin installer/window/obj \
         installer/shell/setup/bin installer/shell/setup/obj \
         installer/shell/uninstall/bin installer/shell/uninstall/obj
  echo "  DEEP=1: build output removed; the next build starts clean."
fi

echo
echo "After"
echo "  at $after  $(git log -1 --format=%s)"
deleted=$(git diff --name-status "$before..$after" | grep -c '^D' || true)
echo "  $(git diff --name-only "$before..$after" | wc -l | tr -d ' ') file(s) changed, $deleted deleted."
if [ "${deleted:-0}" -gt 0 ]; then
  git diff --name-status "$before..$after" | grep '^D' | head -10 | sed 's/^D[[:space:]]*/  gone    /'
fi
echo
echo "Spot check"
for f in admin/new-seed.py admin/panel/server.js admin/start-panel.cmd \
         admin/start-keyserver.cmd engine/aurion/prop/hours.py \
         engine/aurion/runtime/stops.py; do
  [ -f "$f" ] && echo "  ok      $f" || echo "  MISSING $f"
done
echo
