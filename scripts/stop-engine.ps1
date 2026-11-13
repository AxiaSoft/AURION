<#
  Free the AURION ports, and prove they are free.

  Reported from the field, and it survived everything the desk offered:

      Engine running c41fe0a155a016fa - files on disk afc90d9a62857752

  The files were the new build. The engine was an old process. Restart
  did not fix it, Repair install did not fix it, and rebooting Windows
  did - which is the signature of a process that nothing was managing
  to kill.

  The reason was the same three lines of PowerShell copied into
  start-aurion.cmd, restart-aurion.cmd and stop-aurion.cmd:

      Stop-Process -Force -ErrorAction SilentlyContinue
      timeout /t 2
      start the engine

  Every part of that is a guess. Stop-Process is asynchronous, so two
  seconds is a hope rather than a wait. -ErrorAction SilentlyContinue
  throws away the one interesting outcome, which is "access denied" -
  an engine belonging to another account, or started elevated, cannot
  be killed by the desk and nothing said so. The port list was typed in
  rather than read from the configuration, so a machine with a
  non-default engine port was never touched at all. And the owner had
  to be named exactly node, python, pythonw or py, so a python3.12.exe
  or an interpreter under a different name was quietly skipped.

  Then the launcher starts the engine, the new process loses the race
  for the port and exits, the OLD process answers /health with 200, and
  the launcher concludes the engine is up. It is - the wrong one. That
  is the whole bug: nothing ever checked, so every recovery path
  reported success while changing nothing.

  This script is the check. It kills what it is allowed to kill, then
  WAITS for the ports to actually go quiet, and exits non-zero naming
  the process that would not let go. A caller that gets a non-zero exit
  must not start an engine on top of it and must not claim success.

  Usage:
    powershell -ExecutionPolicy Bypass -File scripts\stop-engine.ps1
    ... -Ports 8080,18765 -TimeoutSec 20 -Root C:\AURION

  Exit codes:
    0  every port is free
    1  at least one port is still held; the reason is printed
#>
[CmdletBinding()]
param(
  # Empty means "read them from config\aurion.json, and fall back to
  # the shipped defaults". Hard-coding them here would reintroduce the
  # bug where a customised engine port was never freed.
  [int[]] $Ports = @(),
  [string] $Root = "",
  [int] $TimeoutSec = 20,
  # Print what would be done without killing anything. Used by support
  # to find out who owns a port before touching it.
  [switch] $WhatIfOnly
)

$ErrorActionPreference = "Continue"

if (-not $Root -or -not (Test-Path $Root)) {
  $Root = Split-Path -Parent $PSScriptRoot
}
$RootFull = (Resolve-Path $Root).Path.TrimEnd("\")

# ---------------------------------------------------------------- ports

function Get-AurionPorts {
  param([string] $InstallRoot)
  # The defaults are the last resort, not the source of truth. A desk on
  # 8081 with an engine on 19000 must still be stoppable.
  $found = New-Object System.Collections.Generic.List[int]
  foreach ($p in 8080, 18765, 18766) { $found.Add($p) | Out-Null }
  $cfg = Join-Path $InstallRoot "config\aurion.json"
  if (Test-Path $cfg) {
    try {
      $json = Get-Content -Raw -Path $cfg | ConvertFrom-Json
      foreach ($candidate in @($json.backend.port, $json.engine.port, $json.engine.ea_port, $json.mt5.port)) {
        if ($candidate -and ([int]$candidate) -gt 0 -and -not $found.Contains([int]$candidate)) {
          $found.Add([int]$candidate) | Out-Null
        }
      }
    } catch {
      Write-Host "  config\aurion.json could not be read for its ports; using the defaults"
    }
  }
  return $found.ToArray()
}

if (-not $Ports -or $Ports.Count -eq 0) {
  $Ports = Get-AurionPorts -InstallRoot $RootFull
}

# ------------------------------------------------------------- owners

# Names an AURION runtime can appear under. Wider than the old list:
# a per-version interpreter is python3.12.exe, and the bundled runtime
# has been seen as both python and pythonw.
$OwnerNames = @("node", "py", "pythonw", "pythonw3", "python")

function Test-IsAurionProcess {
  param($Proc)
  if (-not $Proc) { return $false }
  $name = ""
  try { $name = $Proc.ProcessName.ToLower() } catch { $name = "" }

  # Strongest evidence first: the executable, or the script it is
  # running, lives inside this installation. A bundled runtime under
  # <root>\runtime is ours no matter what it is called.
  try {
    $exe = $Proc.Path
    if ($exe -and $exe.ToLower().StartsWith($RootFull.ToLower())) { return $true }
  } catch { }

  if ($OwnerNames -contains $name) { return $true }
  # python3.12, python3, python311 - anything that is plainly a CPython.
  if ($name -match "^python[0-9.]*$") { return $true }
  return $false
}

function Get-PortOwners {
  param([int] $Port)
  $out = @()
  try {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  } catch {
    $conns = $null
  }
  foreach ($c in $conns) {
    $proc = $null
    try { $proc = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue } catch { $proc = $null }
    if ($proc) { $out += $proc }
  }
  return $out
}

function Describe-Process {
  param($Proc)
  $where = ""
  try { if ($Proc.Path) { $where = " (" + $Proc.Path + ")" } } catch { }
  return ("PID " + $Proc.Id + " " + $Proc.ProcessName + $where)
}

# --------------------------------------------------------------- stop

$killed = 0
$refused = @()

foreach ($port in $Ports) {
  foreach ($proc in (Get-PortOwners -Port $port)) {
    $desc = Describe-Process -Proc $proc
    if (-not (Test-IsAurionProcess -Proc $proc)) {
      # Somebody else's software on one of our ports. Killing it would
      # be an unforgivable thing for a trading desk to do silently.
      Write-Host ("  port " + $port + " is held by something that is not AURION: " + $desc + " - left alone")
      $refused += ("port " + $port + " belongs to " + $desc + ", which is not part of AURION")
      continue
    }
    if ($WhatIfOnly) {
      Write-Host ("  would stop " + $desc + " on port " + $port)
      continue
    }
    try {
      Stop-Process -Id $proc.Id -Force -ErrorAction Stop
      $killed = $killed + 1
      Write-Host ("  stopped " + $desc + " on port " + $port)
    } catch {
      # The outcome the old code threw away. Access denied here means the
      # process belongs to another Windows account or is running
      # elevated, and no amount of restarting or repairing will reach it.
      Write-Host ("  could NOT stop " + $desc + " on port " + $port + ": " + $_.Exception.Message)
      $refused += ($desc + " on port " + $port + " could not be stopped: " + $_.Exception.Message)
    }
  }
}

if ($WhatIfOnly) { exit 0 }

# --------------------------------------------------------------- wait

# Stop-Process returns before the process has gone, and a socket can
# linger for a moment after it does. So poll, rather than sleeping for
# a guessed two seconds and hoping.
$deadline = (Get-Date).AddSeconds($TimeoutSec)
$stillHeld = @()
while ($true) {
  $stillHeld = @()
  foreach ($port in $Ports) {
    if ((Get-PortOwners -Port $port).Count -gt 0) { $stillHeld += $port }
  }
  if ($stillHeld.Count -eq 0) { break }
  if ((Get-Date) -ge $deadline) { break }
  Start-Sleep -Milliseconds 400
}

if ($stillHeld.Count -eq 0) {
  if ($killed -gt 0) {
    Write-Host ("  " + $killed + " AURION process(es) stopped; every port is free")
  } else {
    Write-Host "  nothing was listening; every port is free"
  }
  exit 0
}

# ------------------------------------------------------- say the truth

Write-Host ""
Write-Host "  AURION could not free these ports:"
foreach ($port in $stillHeld) {
  foreach ($proc in (Get-PortOwners -Port $port)) {
    Write-Host ("    " + $port + "  <-  " + (Describe-Process -Proc $proc))
  }
}
foreach ($line in $refused) { Write-Host ("    " + $line) }
Write-Host ""
Write-Host "  Starting a second engine now would do nothing: it cannot bind the"
Write-Host "  port, it exits, and the surviving process keeps answering - which"
Write-Host "  is how an installation ends up running code that is no longer on"
Write-Host "  disk. Close AURION completely, or restart Windows, then start again."
exit 1
