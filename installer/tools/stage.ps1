<#
.SYNOPSIS
    Builds the exact file tree that the AURION MSI will ship.

.DESCRIPTION
    Windows Installer packages what it is given, so the payload is assembled
    here - deliberately, file by file - instead of pointing WiX at the source
    tree and hoping. That keeps three classes of file out of every release:

      secrets      data\jwt.secret, data\license\*, data\*.db, logs, exports
      foreign apps store\  (key server)  and  admin\  (update server, panel)
                   both of which are hosted separately and must never be
                   installed on a trader's machine
      build waste  .git, __pycache__, *.pyc, node_modules dev dependencies

    Layout produced:

      stage\app\        -> INSTALLFOLDER
      stage\docs\       -> INSTALLFOLDER   (Documentation feature)
      stage\launcher\   -> INSTALLFOLDER   (installer-owned .vbs helpers)

.PARAMETER SkipNpm
    Reuse an existing stage\app\backend\node_modules instead of running
    "npm ci --omit=dev". Only for fast local iteration - never for a release.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\stage.ps1
#>
[CmdletBinding()]
param(
    [string] $Root  = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string] $Stage = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..")).Path "stage"),
    [switch] $SkipNpm
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Say([string] $msg, [string] $colour = "Gray") { Write-Host "  $msg" -ForegroundColor $colour }

function Copy-Tree {
    param(
        [Parameter(Mandatory)] [string] $From,
        [Parameter(Mandatory)] [string] $To,
        [string[]] $ExcludeDirs  = @(),
        [string[]] $ExcludeFiles = @()
    )
    if (-not (Test-Path $From)) { throw "Source missing: $From" }
    New-Item -ItemType Directory -Force -Path $To | Out-Null

    $fromFull = (Resolve-Path $From).Path.TrimEnd('\')
    Get-ChildItem -Path $From -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($fromFull.Length).TrimStart('\')
        $parts = $rel.Split('\')

        foreach ($bad in $ExcludeDirs) {
            if ($parts -contains $bad) { return }
        }
        foreach ($pattern in $ExcludeFiles) {
            if ($_.Name -like $pattern) { return }
        }

        $target = Join-Path $To $rel
        $dir = Split-Path $target -Parent
        if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    }
}

$appDir      = Join-Path $Stage "app"
$docsDir     = Join-Path $Stage "docs"
$launcherDir = Join-Path $Stage "launcher"

Write-Host ""
Write-Host "AURION payload staging" -ForegroundColor Cyan
Write-Host "  source $Root"
Write-Host "  stage  $Stage"
Write-Host ""

# ---------------------------------------------------------------------------
# 0. Clean slate. A stale stage folder is how ghost files get shipped.
# ---------------------------------------------------------------------------
if (Test-Path $Stage) {
    Say "cleaning previous stage"
    Remove-Item -LiteralPath $Stage -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $appDir, $docsDir, $launcherDir | Out-Null

$noPy = @("__pycache__", ".pytest_cache", ".mypy_cache")

# ---------------------------------------------------------------------------
# 1. Python engine
# ---------------------------------------------------------------------------
Say "engine\"
Copy-Tree -From (Join-Path $Root "engine") -To (Join-Path $appDir "engine") `
          -ExcludeDirs ($noPy + @("models", "tests")) `
          -ExcludeFiles @("*.pyc", "*.pyo", "a.txt")

# ---------------------------------------------------------------------------
# 2. Node.js desk API  (+ production dependencies)
# ---------------------------------------------------------------------------
Say "backend\src"
Copy-Tree -From (Join-Path $Root "backend\src") -To (Join-Path $appDir "backend\src") `
          -ExcludeDirs $noPy -ExcludeFiles @("*.pyc")
Copy-Item (Join-Path $Root "backend\package.json")      (Join-Path $appDir "backend") -Force
Copy-Item (Join-Path $Root "backend\package-lock.json") (Join-Path $appDir "backend") -Force

if ($SkipNpm) {
    Say "npm install skipped (-SkipNpm)" "Yellow"
} else {
    Say "npm ci --omit=dev  (production dependencies only)"
    Push-Location (Join-Path $appDir "backend")
    # npm reports progress on stderr even when it succeeds. Merging that into
    # the pipeline while $ErrorActionPreference is 'Stop' would abort the build
    # on a perfectly good install, so native output is relaxed just here.
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & npm ci --omit=dev --no-audit --no-fund 2>&1 | ForEach-Object { Write-Verbose "$_" }
        if ($LASTEXITCODE -ne 0) {
            throw "npm ci failed with exit code $LASTEXITCODE. Run it by hand in $((Get-Location).Path) to see why."
        }
    } finally {
        $ErrorActionPreference = $previousEap
        Pop-Location
    }

    # npm leaves caches and native build leftovers behind; they bloat the CAB
    # and are never needed at runtime.
    Get-ChildItem (Join-Path $appDir "backend\node_modules") -Recurse -Force -Directory `
        -Include ".cache", ".bin.cache", "test", "tests", "__tests__", ".github" -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Get-ChildItem (Join-Path $appDir "backend\node_modules") -Recurse -Force -File `
        -Include "*.md", "*.markdown", "*.ts.map", "*.map" -ErrorAction SilentlyContinue |
        Remove-Item -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 3. Web desk, translations, helper scripts
# ---------------------------------------------------------------------------
Say "apps\web\"
Copy-Tree -From (Join-Path $Root "apps\web") -To (Join-Path $appDir "apps\web")
# __*.html are local scratch pages used to eyeball skins during development.
# They are git-ignored, but a developer's working copy is what gets staged, so
# the payload drops them explicitly rather than trusting that.
Get-ChildItem (Join-Path $appDir "apps\web") -Filter "__*.html" -File -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

Say "lang\"
Copy-Tree -From (Join-Path $Root "lang") -To (Join-Path $appDir "lang")

Say "scripts\"
Copy-Tree -From (Join-Path $Root "scripts") -To (Join-Path $appDir "scripts")

# ---------------------------------------------------------------------------
# 4. Configuration
#    Factory defaults only. config\aurion.json is NOT shipped: the engine
#    creates it from the factory copy on first run (see ensure_config() in
#    engine\aurion\config.py), which is what makes an upgrade unable to
#    overwrite the trader's live settings.
# ---------------------------------------------------------------------------
Say "config\ (factory defaults only - live config is never shipped)"
$cfgOut = Join-Path $appDir "config"
New-Item -ItemType Directory -Force -Path $cfgOut | Out-Null
foreach ($f in @("aurion.factory.json", "news_calendar.template.csv",
                 "owner.gmail.example", "telegram.token.example")) {
    $src = Join-Path $Root "config\$f"
    if (Test-Path $src) { Copy-Item $src $cfgOut -Force }
}

# ---------------------------------------------------------------------------
# 5. Launch scripts at the tree root
# ---------------------------------------------------------------------------
Say "start/stop scripts"
foreach ($f in @("start-aurion.cmd", "stop-aurion.cmd", "start-desk.cmd",
                 "start-engine.cmd", "README.md")) {
    $src = Join-Path $Root $f
    if (Test-Path $src) { Copy-Item $src $appDir -Force }
}

# ---------------------------------------------------------------------------
# 6. Documentation feature
# ---------------------------------------------------------------------------
Say "docs\ (Documentation feature)"
Copy-Tree -From (Join-Path $Root "docs") -To (Join-Path $docsDir "docs")
foreach ($f in @("AURION-GUIDE.html", "AURION-BACKTEST-GUIDE.html")) {
    $src = Join-Path $Root $f
    if (Test-Path $src) { Copy-Item $src $docsDir -Force }
}

# ---------------------------------------------------------------------------
# 7. Installer-owned launcher helpers
# ---------------------------------------------------------------------------
Say "launcher helpers"
Copy-Item (Join-Path $PSScriptRoot "..\launcher\*.vbs") $launcherDir -Force

# ---------------------------------------------------------------------------
# 8. Safety net: refuse to ship a payload that contains secrets or the
#    separately hosted services. Cheap to run, and it turns a catastrophic
#    mistake into a build error.
# ---------------------------------------------------------------------------
Say "verifying payload"
$forbidden = @(
    @{ Pattern = "jwt.secret";        Why = "JWT signing secret" },
    @{ Pattern = "secret.key";        Why = "licence HMAC secret" },
    @{ Pattern = "*.db";              Why = "user database" },
    @{ Pattern = "*.db-wal";          Why = "user database" },
    @{ Pattern = "*.db-shm";          Why = "user database" },
    @{ Pattern = "aurion.json";       Why = "live configuration (ship the factory copy only)" },
    @{ Pattern = "*.xlsx";            Why = "exported trading history" },
    @{ Pattern = "*.log";             Why = "runtime log" },
    @{ Pattern = "state.json";        Why = "licence state" },
    @{ Pattern = "used.json";         Why = "licence state" }
)
# NOTE: the accumulation below deliberately uses foreach statements, not the
# ForEach-Object cmdlet. Assigning to $problems inside a cmdlet script block
# writes to a child scope, so the list would always come back empty and this
# safety net would silently pass everything.
$problems = @()
foreach ($rule in $forbidden) {
    $hits = @(Get-ChildItem -Path $Stage -Recurse -File -Filter $rule.Pattern -ErrorAction SilentlyContinue)
    foreach ($hit in $hits) {
        $problems += ("{0}  <- {1}" -f $hit.FullName.Substring($Stage.Length), $rule.Why)
    }
}
foreach ($dir in @("store", "admin", ".git", "data")) {
    if (Test-Path (Join-Path $appDir $dir)) { $problems += "$dir\  <- must not be installed on a trader machine" }
}
if ($problems.Count -gt 0) {
    Write-Host ""
    Write-Host "PAYLOAD REJECTED - these must not ship:" -ForegroundColor Red
    foreach ($p in $problems) { Write-Host "    $p" -ForegroundColor Red }
    throw "Staging aborted: forbidden content in payload."
}

# sanity: the thing we actually run must be there
foreach ($must in @("app\backend\src\index.js", "app\engine\main.py",
                    "app\apps\web\index.html", "app\start-aurion.cmd",
                    "launcher\AURION-Stop.vbs")) {
    if (-not (Test-Path (Join-Path $Stage $must))) { throw "Payload incomplete: $must is missing." }
}

$files = @(Get-ChildItem $Stage -Recurse -File)
$sizeMb = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host ""
Write-Host ("  payload OK: {0} files, {1} MB" -f $files.Count, $sizeMb) -ForegroundColor Green
Write-Host ""
