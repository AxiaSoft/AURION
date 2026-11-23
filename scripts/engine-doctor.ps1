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
# Where does a command's interpreter really live?
#
# `py -3.12` is a path to the launcher, not to the interpreter it picks,
# and a bare `python` on a stock Windows is an app execution alias. Both
# can land on the Microsoft Store build, whose sys.executable sits under
# WindowsApps: it redirects writes away from site-packages and, started
# detached, exits with no output and no log. Judging the command instead
# of the interpreter is how a machine was told its Python was fine while
# every launcher refused it.
function Resolve-Exe {
    param([string] $Program, [string[]] $Pre)
    try {
        $out = & $Program @Pre -c "import sys;print(sys.executable)" 2>$null
        $line = @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) | Select-Object -Last 1
        if ($LASTEXITCODE -eq 0 -and $line) { return "$line" }
    } catch { }
    return ""
}
function Test-StoreAlias { param([string] $Path) return ($Path -and $Path -match 'WindowsApps') }

$storeSeen = $false
if (-not $py -and $envPy) {
    if (Test-StoreAlias $envPy) {
        $storeSeen = $true
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
        $exe = Resolve-Exe -Program "py" -Pre @("-$v")
        if (-not $exe) { continue }
        if (Test-StoreAlias $exe) {
            $storeSeen = $true
            Bad "py -$v is the Microsoft Store alias, not an interpreter - skipping it"
            Say "  $exe"
            continue
        }
        $py = "py -$v"; $pyFrom = "py launcher"
    }
}
if (-not $py) {
    $exe = Resolve-Exe -Program "python" -Pre @()
    if ($exe -and (Test-StoreAlias $exe)) {
        $storeSeen = $true
        Bad "a bare 'python' on this machine is the Microsoft Store alias, not an interpreter"
        Say "  $exe"
    } elseif ($exe) {
        $py = "python"; $pyFrom = "PATH"
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

if ($storeSeen) {
    Say ""
    Bad "The Microsoft Store Python was found on this machine and is refused everywhere."
    Say "It is an app execution alias: it resolves only inside an interactive session"
    Say "belonging to the user who installed it, it redirects writes away from"
    Say "site-packages, and started detached - which is how the desk starts the"
    Say "engine - it exits without output and without a log."
    Say "The repair is to give this installation its own interpreter:"
    Say "  powershell -ExecutionPolicy Bypass -File scripts\provision.ps1"
    Say "and afterwards data\runtime.env must read"
    Say "  PYTHON=$Root\runtime\python\python.exe"
    Say ""
    Say "Removing the Store Python is optional - AURION refuses it either way -"
    Say "but it does stop 'py' and a bare 'python' resolving to it for everything"
    Say "else on this machine:"
    Say "  Settings > Apps > Installed apps > Python 3.12 (Microsoft Store) > Uninstall"
    Say "  Settings > Apps > Advanced app settings > App execution aliases:"
    Say "    turn python.exe and python3.exe OFF"
    Say "Do it AFTER this installation has its own runtime\python, not before."
}

if ($envNode -and -not (Test-Path $envNode)) { Bad "data\runtime.env points at a Node that is no longer there: $envNode" }

# ------------------------------------------------------------- 2. ports
Head "2. Who holds AURION's ports"

# Is this process one of ours?
#
# The first version of this asked only where the EXECUTABLE lived, and
# on the machine that prompted it the answer was always "no": the engine
# was running under C:\Program Files\WindowsApps\...\python3.12.exe and
# the desk under C:\Program Files\nodejs\node.exe. Neither is inside the
# install folder, and neither ever will be unless this installation has
# its own runtime - so the doctor called AURION's own two processes
# foreign and told the user to go and kill them.
#
# What makes a process ours is not whose executable it is. It is what it
# was told to run. An interpreter is a borrowed tool; the argument after
# it - this install folder, engine\main.py, the desk's server.js - is
# the fact that matters, and it is in the command line.
function Get-CommandLine {
    param([int] $ProcessId)
    try {
        return [string] (Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop).CommandLine
    } catch { }
    try {
        return [string] (Get-WmiObject Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop).CommandLine
    } catch { }
    return ""
}

function Get-Owner {
    param([string] $Path, [string] $CommandLine)
    $root = $Root.ToLower()
    if ($Path -and $Path.ToLower().StartsWith($root)) { return "mine" }
    if (-not $CommandLine) { return "foreign" }
    $cl = $CommandLine.ToLower()

    # The install folder named anywhere in the command line: this is how
    # the launcher starts both halves, with absolute paths.
    if ($cl.Contains($root)) { return "mine" }

    # An absolute path to SOMEBODY ELSE'S engine. Worth separating,
    # because the advice is the opposite: a second installation holding
    # this one's port is a thing to stop, not a thing to celebrate.
    if ($cl -match '([a-z]:\\[^"]*?)\\engine\\main\.py') {
        if ($Matches[1] -ne $root) { return "other" }
        return "mine"
    }

    # Started from inside the folder, with relative paths - which is
    # what hidden.vbs does: it sets the working directory and then runs
    # `python engine\main.py` or `node src\index.js`. The executable is
    # a borrowed interpreter and tells us nothing; the script does.
    foreach ($mark in @("engine\main.py", "engine/main.py",
                        "src\index.js", "src/index.js")) {
        if ($cl.Contains($mark)) { return "mine" }
    }
    return "foreign"
}

$ourEnginePid = 0
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
        $cmdline = Get-CommandLine -ProcessId ([int] $c.OwningProcess)
        $owner = Get-Owner -Path $path -CommandLine $cmdline
        if ($owner -eq "other") {
            Bad "$p   held by ANOTHER AURION installation ($name, pid $($c.OwningProcess))"
            Say "  $cmdline"
            Say "  Two installations cannot share a port. Stop that one, or give"
            Say "  this one its own port in config\aurion.json."
            continue
        }
        if ($owner -eq "mine") {
            Good "$p   held by $name (pid $($c.OwningProcess)) - this installation"
            if ($p -ne 8080) { $ourEnginePid = [int] $c.OwningProcess }
            # Said plainly, because it is the actual fault on a machine
            # that has no runtime\python: our engine, somebody else's
            # interpreter. Nothing to kill - something to provision.
            if ($path -and -not $path.ToLower().StartsWith($Root.ToLower())) {
                Say "  running under an interpreter outside this folder: $path"
            }
        } else {
            Bad "$p   held by $name (pid $($c.OwningProcess))  $path"
            if ($cmdline) { Say "  $cmdline" }
        }
    }
}
Say ""
Say "A port held by a process that will not die is the failure that looks"
Say "like 'the engine will not start': the new one cannot bind and exits."
Say "A port held by THIS installation is not that failure - it is the"
Say "engine doing its job, and killing it only costs you a restart."
Say "  powershell -ExecutionPolicy Bypass -File scripts\stop-engine.ps1 -WhatIfOnly"

# ------------------------------------------------------------ 3. health
Head "3. Does the engine answer, and is it running the files on disk"

$health = $null
try {
    $health = Invoke-RestMethod -UseBasicParsing -TimeoutSec 4 "http://127.0.0.1:$Port/health"
} catch { }

if (-not $health) {
    Bad "no answer on http://127.0.0.1:$Port/health"
    if ($ourEnginePid -gt 0) {
        # The worst of the three cases, and the one that reads as "it
        # will not start": the port is held by our own engine, which is
        # no longer answering on it. A new engine cannot bind, so it
        # exits in silence, for as long as this one is alive.
        Bad "...but this installation's engine (pid $ourEnginePid) is still holding $Port"
        Say "It is alive and not serving. Nothing new can bind while it is there:"
        Say "  powershell -ExecutionPolicy Bypass -File scripts\stop-engine.ps1"
        Say "  .\start-engine.cmd"
    }
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
