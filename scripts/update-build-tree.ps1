<#
    Bring D:\AURION-BUILD up to date, and say what arrived.

    Written because "I pulled but I do not see the change" has now cost
    several rounds, and every time the code was on the branch and the
    build tree was not.

    The usual cause is a branch with no upstream. These instructions:

        git fetch origin arena/01a10ba4-aurion
        git checkout -f -B arena/01a10ba4-aurion FETCH_HEAD

    create a local branch that tracks nothing, so a later bare `git pull`
    has nowhere to pull from. It prints a complaint and leaves the tree
    untouched, which from the outside looks exactly like a pull that
    worked and changed nothing.

    This fetches the branch by name - never relying on tracking - shows
    the commits that are about to land, and refuses to throw away local
    edits without being told to.

        powershell -ExecutionPolicy Bypass -File scripts\update-build-tree.ps1

    Add -Force to discard local changes (the regenerated icon, a .env you
    were testing with) and take the branch exactly as it is on GitHub.
#>

[CmdletBinding()]
param(
    [string] $Branch = "arena/01a10ba4-aurion",
    [switch] $Force
)

$ErrorActionPreference = "Stop"

function Say  { param([string] $T) Write-Host "  $T" }
function Head { param([string] $T) Write-Host ""; Write-Host $T -ForegroundColor Cyan }
function Good { param([string] $T) Write-Host "  $T" -ForegroundColor Green }
function Warn { param([string] $T) Write-Host "  $T" -ForegroundColor Yellow }

# Run from the repository, wherever this script was called from.
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $root

Write-Host ""
Write-Host "  AURION build tree update" -ForegroundColor White
Write-Host "  ------------------------" -ForegroundColor White
Say "folder  $root"
Say "branch  $Branch"

if (-not (Test-Path ".git")) {
    Warn "This is not a git checkout. Nothing to update."
    exit 1
}

# ---------------------------------------------------------------------------
# What is here now
# ---------------------------------------------------------------------------
$before = (git rev-parse --short HEAD).Trim()
$dirty  = @(git status --porcelain)

Head "Before"
Say "at $before  $((git log -1 --format='%s').Trim())"

if ($dirty.Count -gt 0) {
    Warn "$($dirty.Count) local change(s) in this folder:"
    $dirty | Select-Object -First 8 | ForEach-Object { Say "    $_" }
    if ($dirty.Count -gt 8) { Say "    ... and $($dirty.Count - 8) more" }

    if (-not $Force) {
        Write-Host ""
        Warn "Stopping, so none of that is lost."
        Warn "Keep them:     git stash"
        Warn "Discard them:  run this again with -Force"
        exit 2
    }
    Warn "-Force given; these will be discarded."
}

# ---------------------------------------------------------------------------
# Fetch by name, never by tracking
# ---------------------------------------------------------------------------
Head "Fetching"
git fetch origin $Branch 2>&1 | ForEach-Object { Say $_ }
if ($LASTEXITCODE -ne 0) {
    Warn "Could not reach GitHub. Check the connection and try again."
    exit 3
}

$target = (git rev-parse --short FETCH_HEAD).Trim()
if ($target -eq $before -and $dirty.Count -eq 0) {
    Head "Already up to date"
    Say "at $target - nothing new on $Branch."
    Write-Host ""
    exit 0
}

# ---------------------------------------------------------------------------
# What is about to land
# ---------------------------------------------------------------------------
$incoming = @(git log --oneline "$before..FETCH_HEAD" 2>$null)
if ($incoming.Count -gt 0) {
    Head "Arriving ($($incoming.Count) commit(s))"
    $incoming | Select-Object -First 15 | ForEach-Object { Say $_ }
    if ($incoming.Count -gt 15) { Say "... and $($incoming.Count - 15) more" }
}

Head "Updating"
git reset --hard FETCH_HEAD 2>&1 | ForEach-Object { Say $_ }
if ($LASTEXITCODE -ne 0) {
    Warn "The reset failed. Nothing was changed."
    exit 4
}

# Point the branch at origin, so a plain `git pull` works from now on.
git branch --set-upstream-to="origin/$Branch" 2>&1 | Out-Null

$after = (git rev-parse --short HEAD).Trim()

# ---------------------------------------------------------------------------
# Prove it
# ---------------------------------------------------------------------------
Head "After"
Good "at $after  $((git log -1 --format='%s').Trim())"

$files = @(git diff --name-only "$before..$after" 2>$null)
if ($files.Count -gt 0) {
    Say ""
    Say "$($files.Count) file(s) changed. A few of them:"
    $files | Select-Object -First 10 | ForEach-Object { Say "    $_" }
}

# The question that actually gets asked: is the thing I came for here?
Head "Spot check"
$look = @(
    "admin/new-seed.py",
    "admin/panel/server.js",
    "admin/start-panel.cmd",
    "admin/start-keyserver.cmd",
    "engine/aurion/prop/hours.py",
    "engine/aurion/runtime/stops.py"
)
foreach ($f in $look) {
    if (Test-Path $f) { Good "$f" } else { Warn "$f   MISSING" }
}

Write-Host ""
Say "Next:  powershell -ExecutionPolicy Bypass -File installer\tools\build-msi.ps1"
Write-Host ""
