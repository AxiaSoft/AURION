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

echo
echo "After"
echo "  at $(git rev-parse --short HEAD)  $(git log -1 --format=%s)"
echo
echo "Spot check"
for f in admin/new-seed.py admin/panel/server.js admin/start-panel.cmd \
         admin/start-keyserver.cmd engine/aurion/prop/hours.py \
         engine/aurion/runtime/stops.py; do
  [ -f "$f" ] && echo "  ok      $f" || echo "  MISSING $f"
done
echo
