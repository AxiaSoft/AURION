<#
    Why is the engine not running?

    Written after a session that went: the engine stopped during an
    update, the desk sat on its refreshing screen, and then nothing
    would bring the engine back - not closing the app, not
    stop-aurion.cmd, not start-engine.cmd. Every one of those reports a
    different half of the truth, and none of them reports the one fact
    that decides what to do.

    This prints the facts, in the order they matter:

      1. which interpreter this installation actually uses, and whether
         it can import the engine's libraries;
      2. who is holding AURION's ports, which is the failure that looks
         exactly like "it will not start" - a second engine cannot bind,
         so it exits in silence while the old one keeps answering;
      3. whether the engine answers, and whether the code it is running
         is the code on disk;
      4. the last real error out of data\logs\engine.log, rather than
         the last line, which is usually a shutdown notice.

    Reads only. It starts nothing, stops nothing, and needs no
    administrator.

        powershell -ExecutionPolicy Bypass -File scripts\engine-doctor.ps1
#>

[CmdletBinding()]
param(
    [string] $Root = "",
    [int] $Port = 0
)

$ErrorActionPreference = "Continue"

function Head { param([string] $T) Write-Host ""; Write-Host "  $T" -ForegroundColor Cyan }
function Say  { param([string] $T) Write-Host "    $T" }
function Good { param([string] $T) Write-Host "    $T" -ForegroundColor Green }
function Bad  { param([string] $T) Write-Host "    $T" -ForegroundColor Yellow }

if (-not $Root -or -not (Test-Path $Root)) { $Root = Split-Path -Parent $PSScriptRoot }
$Root = (Resolve-Path $Root).Path.TrimEnd("\")

Write-Host ""
Write-Host "  AURION engine doctor" -ForegroundColor White
Write-Host "  --------------------" -ForegroundColor White
Say "install  $Root"

# ---------------------------------------------------------------- ports
if ($Port -le 0) {
    $Port = 18765
    $cfg = Join-Path $Root "config\aurion.json"
    if (Test-Path $cfg) {
        try {
            $json = Get-Content -Raw -Path $cfg | ConvertFrom-Json
            if ($json.engine -and $json.engine.port) { $Port = [int] $json.engine.port }
        } catch { }
    }
}

# ----------------------------------------------------------- 1. runtime
Head "1. The interpreter this installation uses"

$py = $null
$pyFrom = ""
$bundled = Join-Path $Root "runtime\python\python.exe"
if (Test-Path $bundled) { $py = $bundled; $pyFrom = "runtime\python" }

$envFile = Join-Path $Root "data\runtime.env"
$envPy = ""
$envNode = ""
if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*PYTHON\s*=\s*(.+?)\s*$') { $envPy = $Matches[1] }
        if ($line -match '^\s*NODE\s*=\s*(.+?)\s*$')   { $envNode = $Matches[1] }
    }
}
if (-not $py -and $envPy) {
    if ($envPy -match 'WindowsApps') {
        Bad "data\runtime.env points at the Microsoft Store alias - that is not an interpreter"
        Say "  $envPy"
    } elseif (Test-Path $envPy) {
        $py = $envPy; $pyFrom = "data\runtime.env"
    } else {
        Bad "data\runtime.env points at a Python that is no longer there:"
        Say "  $envPy"
    }
}
if (-not $py) {
    foreach ($v in "3.12", "3.11", "3.10") {
        if ($py) { continue }
        try {
            & py "-$v" -c "import sys" 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { $py = "py -$v"; $pyFrom = "py launcher" }
        } catch { }
    }
}

if (-not $py) {
    Bad "no usable Python found"
    Say "fix:  powershell -ExecutionPolicy Bypass -File scripts\provision.ps1"
} else {
    Good "$py   (via $pyFrom)"
    $exe = $py; $pre = @()
    if ($py -like "py -*") { $exe = "py"; $pre = @($py.Split(" ")[1]) }
    try {
        $ver = & $exe @pre -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($ver) {
            if ([version]"$ver" -ge [version]"3.13") {
                Bad "Python $ver - the engine needs 3.10, 3.11 or 3.12 (NumPy has no wheels above 3.12)"
            } else { Good "Python $ver" }
        }
        $missing = & $exe @pre -c "import importlib.util as u;print(','.join(m for m in ('fastapi','numpy','sklearn','uvicorn') if u.find_spec(m) is None))" 2>$null
        if ($missing) {
            Bad "missing libraries: $missing"
            Say "fix:  powershell -ExecutionPolicy Bypass -File scripts\provision.ps1"
            Say "      powershell -ExecutionPolicy Bypass -File scripts\fix-numpy.ps1"
        } else { Good "fastapi, numpy, sklearn, uvicorn all import" }
    } catch {
        Bad "the interpreter could not be run: $($_.Exception.Message)"
    }
}

if ($envNode -and -not (Test-Path $envNode)) { Bad "data\runtime.env points at a Node that is no longer there: $envNode" }

# ------------------------------------------------------------- 2. ports
Head "2. Who holds AURION's ports"

foreach ($p in @(8080, $Port, ($Port + 1))) {
    $conns = @()
    try { $conns = @(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction Stop) } catch { }
    if (-not $conns -or $conns.Count -eq 0) {
        Say "$p   free"
        continue
    }
    foreach ($c in $conns) {
        $proc = $null
        try { $proc = Get-Process -Id $c.OwningProcess -ErrorAction Stop } catch { }
        $name = if ($proc) { $proc.ProcessName } else { "unknown" }
        $path = ""
        try { if ($proc) { $path = $proc.Path } } catch { }
        $mine = $path -and $path.ToLower().StartsWith($Root.ToLower())
        if ($mine) { Good "$p   held by $name (pid $($c.OwningProcess)) - this installation" }
        else { Bad "$p   held by $name (pid $($c.OwningProcess))  $path" }
    }
}
Say ""
Say "A port held by a process that will not die is the failure that looks"
Say "like 'the engine will not start': the new one cannot bind and exits."
Say "  powershell -ExecutionPolicy Bypass -File scripts\stop-engine.ps1 -WhatIfOnly"

# ------------------------------------------------------------ 3. health
Head "3. Does the engine answer, and is it running the files on disk"

$health = $null
try {
    $health = Invoke-RestMethod -UseBasicParsing -TimeoutSec 4 "http://127.0.0.1:$Port/health"
} catch { }

if (-not $health) {
    Bad "no answer on http://127.0.0.1:$Port/health"
} else {
    Good "the engine answers on $Port"
    if ($health.build_id) { Say "running build $($health.build_id)" }
}

$desk = $null
try { $desk = Invoke-RestMethod -UseBasicParsing -TimeoutSec 4 "http://127.0.0.1:8080/api/health" } catch { }
if (-not $desk) { Bad "the desk does not answer on 8080" }
elseif ($desk.build -and $desk.build.restart_required) {
    Bad "the engine is running older code than the files on disk - it needs restarting"
    Say "running $($desk.build.running)  /  on disk $($desk.build.disk)"
} elseif ($desk) { Good "the desk answers on 8080" }

# -------------------------------------------------------------- 4. logs
Head "4. The last error the engine wrote"

$log = Join-Path $Root "data\logs\engine.log"
if (-not (Test-Path $log)) {
    Bad "data\logs\engine.log does not exist - the engine has never written anything"
    Say "That usually means it never started: see section 1."
} else {
    $lines = Get-Content $log -Tail 400
    $hits = @($lines | Select-String -Pattern "Traceback|Error|error:|ERROR|Address already in use|ModuleNotFoundError|ImportError|SystemExit" -SimpleMatch:$false)
    if ($hits.Count -eq 0) {
        Say "nothing that looks like an error in the last 400 lines"
        Say "last line: $($lines[-1])"
    } else {
        $from = [Math]::Max(0, $hits[-1].LineNumber - 1 - 6)
        foreach ($l in $lines[$from..([Math]::Min($lines.Count - 1, $from + 18))]) { Say $l }
    }
}

$setup = Join-Path $Root "data\logs\setup.log"
if (Test-Path $setup) {
    Head "   and the last thing setup decided"
    foreach ($l in (Get-Content $setup -Tail 6)) { Say $l }
}

Write-Host ""
Write-Host "  Done. Nothing was changed." -ForegroundColor White
Write-Host ""
