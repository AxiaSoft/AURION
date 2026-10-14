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

    A file deleted on the branch is deleted here too. `git reset --hard`
    removes the ones git is tracking; this also sweeps away untracked
    leftovers, which is the other half of the same complaint - a file
    that was removed upstream but stayed on disk because an earlier
    checkout left it behind, so the build kept compiling it.

    Protected from that sweep, because they are expensive or secret and
    git ignores them anyway: installer\vendor, node_modules, .venv_dev,
    every .env and data directory.

    Add -Deep to also throw away compiled build output (installer\build,
    installer\output, every bin and obj) so the next MSI is built from
    nothing but what GitHub just sent.
#>

[CmdletBinding()]
param(
    [string] $Branch = "arena/01a10ba4-aurion",
    [switch] $Force,
    [switch] $Deep
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
# Remove what the branch removed
#
# reset --hard has already deleted the tracked files that went away. What
# it never touches is an untracked file - and a file deleted upstream
# often survives exactly that way, because some earlier checkout wrote it
# while it was still tracked and nothing has owned it since. It then sits
# in the build tree looking current.
# ---------------------------------------------------------------------------
Head "Sweeping"

# Never sweep these: they are costly to rebuild or hold secrets, and git
# ignores them, so they are untracked by design.
$keep = @(
    "-e", "installer/vendor",
    "-e", "node_modules",
    "-e", ".venv_dev",
    "-e", "*.env",
    "-e", "panel.token",
    "-e", "seed.key",
    "-e", "data/"
)

$stray = @(@(git clean -nd @keep 2>$null) | ForEach-Object { $_ -replace "^Would remove ", "" })
if ($stray.Count -gt 0) {
    Say "$($stray.Count) leftover file(s)/folder(s) not on the branch:"
    $stray | Select-Object -First 10 | ForEach-Object { Say "    $_" }
    if ($stray.Count -gt 10) { Say "    ... and $($stray.Count - 10) more" }
    git clean -fd @keep 2>&1 | Out-Null
    Good "removed."
} else {
    Say "nothing left over."
}

if ($Deep) {
    $built = @(
        "installer\build", "installer\output",
        "installer\window\bin", "installer\window\obj",
        "installer\shell\setup\bin", "installer\shell\setup\obj",
        "installer\shell\uninstall\bin", "installer\shell\uninstall\obj"
    )
    $gone = 0
    foreach ($b in $built) {
        if (Test-Path $b) { Remove-Item -Recurse -Force $b; $gone++ }
    }
    Say "-Deep: removed $gone build output folder(s); the next build starts clean."
}

# ---------------------------------------------------------------------------
# Prove it
# ---------------------------------------------------------------------------
Head "After"
Good "at $after  $((git log -1 --format='%s').Trim())"

$changes = @(git diff --name-status "$before..$after" 2>$null)
$added   = @($changes | Where-Object { $_ -match "^A" })
$deleted = @($changes | Where-Object { $_ -match "^D" })
$edited  = @($changes | Where-Object { $_ -match "^M" })

if ($changes.Count -gt 0) {
    Say ""
    Say "$($changes.Count) file(s): $($added.Count) new, $($edited.Count) changed, $($deleted.Count) deleted."
    $changes | Select-Object -First 10 | ForEach-Object { Say "    $_" }
    if ($changes.Count -gt 10) { Say "    ... and $($changes.Count - 10) more" }
}
if ($deleted.Count -gt 0) {
    Say ""
    Say "Deleted on the branch, and now gone from this folder:"
    $deleted | Select-Object -First 10 | ForEach-Object { Say "    $($_ -replace '^D\s+', '')" }
    if ($deleted.Count -gt 10) { Say "    ... and $($deleted.Count - 10) more" }
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
