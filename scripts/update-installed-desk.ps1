<#
.SYNOPSIS
    Update an already-installed AURION in place from the GitHub branch.

.DESCRIPTION
    An installed AURION reads its files from %LocalAppData%\Programs\AURION.
    Nothing in a git branch reaches that folder, and no amount of clearing a
    browser cache ever will: the desk is not stale, it is a different copy.
    Rebuilding the MSI for every change is a long way round when the change
    is a handful of text files.

    This copies the desk, the engine, the translations and the factory
    config from a branch of the repository over the installed copy, and
    leaves alone the two things that belong to the person using it:

      data\                  trades, licence state, logs, the database
      config\aurion.json     their settings

    It also keeps the installed copy honest. apps\web\demo\ and js\demo.js
    are the GitHub Pages demo - they fake the API and the engine so the
    published page has something to show. An installed AURION has both for
    real, so the demo is excluded here exactly as the installer excludes it,
    and the script tag that loads it is stripped from index.html. Putting a
    fake tape next to a live one on a trading machine is not a convenience.

    A backup of everything it is about to overwrite is taken first.

.PARAMETER Branch
    Which branch to take. Defaults to the branch this work lives on.

.PARAMETER InstallFolder
    Where AURION is installed. Found automatically in the usual place.

.PARAMETER FromFolder
    Use a local checkout instead of downloading. Point it at the repository
    root (the folder containing apps\, engine\, lang\).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File update-installed-desk.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File update-installed-desk.ps1 -FromFolder C:\src\AURION
#>
[CmdletBinding()]
param(
    [string] $Branch = "arena/01a10ba4-aurion",
    [string] $InstallFolder,
    [string] $FromFolder,
    [switch] $NoBackup
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Say  ($m) { Write-Host "  $m" }
function Head ($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }
function Warn ($m) { Write-Host "  ! $m" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# 1. Find the installed copy
# ---------------------------------------------------------------------------
Head "Looking for the installed AURION"

if (-not $InstallFolder) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\AURION"),
        (Join-Path ${env:ProgramFiles} "AURION"),
        (Join-Path ${env:ProgramFiles(x86)} "AURION")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    # The installer records where it went; trust that over a guess.
    foreach ($key in @("HKCU:\Software\AURION", "HKLM:\Software\AURION")) {
        try {
            $v = (Get-ItemProperty -Path $key -ErrorAction Stop).InstallFolder
            if ($v -and (Test-Path -LiteralPath $v)) { $candidates = @($v) + $candidates }
        } catch { }
    }
    $InstallFolder = $candidates | Select-Object -First 1
}

if (-not $InstallFolder -or -not (Test-Path -LiteralPath $InstallFolder)) {
    throw "Could not find an installed AURION. Pass -InstallFolder ""C:\path\to\AURION""."
}
if (-not (Test-Path -LiteralPath (Join-Path $InstallFolder "apps\web\index.html"))) {
    throw "$InstallFolder does not look like an AURION install (no apps\web\index.html)."
}
Say $InstallFolder

# ---------------------------------------------------------------------------
# 2. Get the new files
# ---------------------------------------------------------------------------
$temp = Join-Path ([IO.Path]::GetTempPath()) ("aurion-update-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
$cleanupTemp = $false

if ($FromFolder) {
    Head "Using a local checkout"
    $source = (Resolve-Path -LiteralPath $FromFolder).Path
    Say $source
} else {
    Head "Downloading $Branch"
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    $cleanupTemp = $true
    $zip = Join-Path $temp "branch.zip"
    $url = "https://codeload.github.com/AxiaSoft/AURION/zip/refs/heads/$Branch"
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    } catch {
        throw "Download failed: $($_.Exception.Message)`nIf this machine is offline, use -FromFolder with a copy of the repository."
    }
    Expand-Archive -LiteralPath $zip -DestinationPath $temp -Force
    $source = (Get-ChildItem -LiteralPath $temp -Directory | Select-Object -First 1).FullName
    Say ("unpacked to " + $source)
}

foreach ($need in @("apps\web\index.html", "engine\main.py", "lang\en.json")) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $need))) {
        throw "The source does not look like the AURION repository (missing $need)."
    }
}

# ---------------------------------------------------------------------------
# 3. Stop the running desk
# ---------------------------------------------------------------------------
Head "Stopping AURION if it is running"
$stopper = Join-Path $InstallFolder "AURION-Stop.vbs"
if (Test-Path -LiteralPath $stopper) {
    try { & wscript.exe //nologo $stopper | Out-Null } catch { }
}
foreach ($name in @("AURION", "aurion", "pythonw", "python", "node")) {
    foreach ($proc in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
        # Reading .Path on a process this account cannot open raises, and
        # with ErrorActionPreference = Stop that would end the update over a
        # process that has nothing to do with AURION.
        $path = $null
        try { $path = $proc.Path } catch { continue }
        if (-not $path) { continue }
        if (-not $path.StartsWith($InstallFolder, [StringComparison]::OrdinalIgnoreCase)) { continue }
        Say ("closing " + $proc.ProcessName + " (" + $proc.Id + ")")
        try { $proc.CloseMainWindow() | Out-Null; Start-Sleep -Milliseconds 400 } catch { }
        try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
    }
}
Start-Sleep -Milliseconds 600

# ---------------------------------------------------------------------------
# 4. Back up what is about to be overwritten
# ---------------------------------------------------------------------------
# Everything below is replaceable from the repository, so the backup exists
# for one reason: to make going back a copy instead of a reinstall.
$parts = @("apps\web", "engine", "backend", "lang", "scripts", "config\aurion.factory.json")

if (-not $NoBackup) {
    $stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
    $backup = Join-Path $InstallFolder "backup-$stamp"
    Head "Backing up to $backup"
    foreach ($p in $parts) {
        $from = Join-Path $InstallFolder $p
        if (-not (Test-Path -LiteralPath $from)) { continue }
        $to = Join-Path $backup $p
        New-Item -ItemType Directory -Path (Split-Path -Parent $to) -Force | Out-Null
        Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
        Say $p
    }
}

# ---------------------------------------------------------------------------
# 5. Copy the new files in
# ---------------------------------------------------------------------------
Head "Updating"

function Copy-Tree {
    param([string] $From, [string] $To, [string[]] $ExcludeDirs = @(), [string[]] $ExcludeFiles = @())
    if (-not (Test-Path -LiteralPath $From)) { return }
    New-Item -ItemType Directory -Path $To -Force | Out-Null
    $skipDir = $ExcludeDirs | ForEach-Object { [IO.Path]::DirectorySeparatorChar + $_ + [IO.Path]::DirectorySeparatorChar }
    Get-ChildItem -LiteralPath $From -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($From.Length).TrimStart('\', '/')
        $probe = [IO.Path]::DirectorySeparatorChar + $rel + [IO.Path]::DirectorySeparatorChar
        foreach ($d in $skipDir) { if ($probe -like "*$d*") { return } }
        foreach ($f in $ExcludeFiles) { if ($_.Name -eq $f) { return } }
        if ($_.Name -like "__*.html") { return }      # local scratch pages
        $dest = Join-Path $To $rel
        New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
        # Installed files can carry the read-only bit, which makes Copy-Item
        # fail with access denied rather than anything informative.
        if (Test-Path -LiteralPath $dest) { try { Set-ItemProperty -LiteralPath $dest -Name IsReadOnly -Value $false } catch { } }
        Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    }
}

Say "apps\web\  (without the Pages demo)"
Copy-Tree -From (Join-Path $source "apps\web") -To (Join-Path $InstallFolder "apps\web") `
          -ExcludeDirs @("demo") -ExcludeFiles @("demo.js")

# The same strip the installer does: an installed desk must not ask for a
# demo file that is deliberately absent.
$deskIndex = Join-Path $InstallFolder "apps\web\index.html"
$indexHtml = Get-Content -LiteralPath $deskIndex -Raw
$stripped  = [regex]::Replace(
    $indexHtml,
    '(?s)\s*<!--(?:(?!-->).)*?-->\s*(?=<script[^>]*\bsrc="js/demo\.js)|\s*<script[^>]*\bsrc="js/demo\.js[^>]*>\s*</script>',
    '')
if ($stripped -ne $indexHtml) {
    Set-Content -LiteralPath $deskIndex -Value $stripped -NoNewline
    Say "removed the demo script tag"
}

foreach ($p in @("engine", "backend", "lang", "scripts")) {
    Say "$p\"
    Copy-Tree -From (Join-Path $source $p) -To (Join-Path $InstallFolder $p) -ExcludeDirs @("__pycache__", "tests")
}

$factory = Join-Path $source "config\aurion.factory.json"
if (Test-Path -LiteralPath $factory) {
    Say "config\aurion.factory.json  (your aurion.json is untouched)"
    $dest = Join-Path $InstallFolder "config\aurion.factory.json"
    if (Test-Path -LiteralPath $dest) { try { Set-ItemProperty -LiteralPath $dest -Name IsReadOnly -Value $false } catch { } }
    Copy-Item -LiteralPath $factory -Destination $dest -Force
}

# Compiled Python from the old version shadows the new source on some
# layouts, which produces the exact symptom this script exists to fix.
Get-ChildItem -LiteralPath (Join-Path $InstallFolder "engine") -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

if ($cleanupTemp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }

# ---------------------------------------------------------------------------
# 6. Say what landed, so "did it work" is not a matter of opinion
# ---------------------------------------------------------------------------
Head "Done"
$tag = ([regex]::Match((Get-Content -LiteralPath $deskIndex -Raw), 'js/app\.js\?v=([^"]+)')).Groups[1].Value
Say "Installed build token: $tag"
Say "Start AURION, open Settings -> Language, and check the number beside the version."
Say "If it reads $tag, you are on the new desk."
Write-Host ""
