<#
    What AURION has actually registered on this machine.

    Written because "I uninstalled from Control Panel and it used Windows'
    uninstaller" and "the fix is in, rebuild" is a conversation that can
    repeat forever without either side seeing the same facts. This prints
    the facts: which entry Windows is showing, what its Uninstall button
    runs, and whether the program that button names is actually there.

    Reads only. It changes nothing and needs no administrator.

        powershell -ExecutionPolicy Bypass -File scripts\check-install.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

function Head { param([string] $T) Write-Host ""; Write-Host $T -ForegroundColor Cyan }
function Say  { param([string] $T) Write-Host "  $T" }
function Good { param([string] $T) Write-Host "  $T" -ForegroundColor Green }
function Bad  { param([string] $T) Write-Host "  $T" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  AURION installation check" -ForegroundColor White
Write-Host "  -------------------------" -ForegroundColor White

# ---------------------------------------------------------------------------
# AURION's own state
# ---------------------------------------------------------------------------
Head "AURION's own registry key"
$ownKey = "HKCU:\Software\AxiaSoft\AURION"
$own = $null
try { $own = Get-ItemProperty -Path $ownKey -ErrorAction Stop } catch { }

if (-not $own) {
    Bad "not found at $ownKey"
    Say "AURION does not appear to be installed for this user."
} else {
    Say "InstallFolder  $($own.InstallFolder)"
    Say "Version        $($own.Version)"
    if ($own.PSObject.Properties.Name -contains "ProductCode") {
        Good "ProductCode    $($own.ProductCode)"
    } else {
        Bad "ProductCode    MISSING"
        Say "This installation predates the uninstaller work. The entry in"
        Say "Control Panel will still be Windows' own."
    }
}

# ---------------------------------------------------------------------------
# What Control Panel is showing
# ---------------------------------------------------------------------------
Head "Entries in Add or Remove Programs"

$roots = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)

$found = @()
foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    foreach ($child in Get-ChildItem $root -ErrorAction SilentlyContinue) {
        $entry = $null
        try { $entry = Get-ItemProperty -Path $child.PSPath -ErrorAction Stop } catch { continue }
        $name = "$($entry.DisplayName)"
        if ($name -notlike "*AURION*") { continue }
        $found += [pscustomobject]@{
            Key             = $child.PSChildName
            Hive            = if ($root -like "HKCU:*") { "HKCU" } else { "HKLM" }
            DisplayName     = $name
            Version         = "$($entry.DisplayVersion)"
            SystemComponent = [int]("$($entry.SystemComponent)" -as [int])
            Uninstall       = "$($entry.UninstallString)"
        }
    }
}

if ($found.Count -eq 0) {
    Bad "no AURION entry found in any Uninstall key"
} else {
    foreach ($e in $found) {
        Write-Host ""
        Say "$($e.Hive)\...\Uninstall\$($e.Key)"
        Say "  DisplayName      $($e.DisplayName)  $($e.Version)"
        if ($e.SystemComponent -eq 1) {
            Say "  SystemComponent  1  (hidden from Control Panel - this is the MSI's own entry)"
        } else {
            Say "  SystemComponent  0  (this is what Control Panel shows)"
        }
        Say "  UninstallString  $($e.Uninstall)"

        if ($e.SystemComponent -ne 1) {
            if ($e.Uninstall -like "*AURION-Uninstall.exe*") {
                Good "  -> Uninstall opens AURION's own window. Correct."
            } elseif ($e.Uninstall -like "*msiexec*" -or $e.Uninstall -like "*MsiExec*") {
                Bad "  -> Uninstall goes straight to Windows Installer."
                Bad "     This installation was made before the change, or the"
                Bad "     build that produced it predates it."
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Is the program that entry names actually there?
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# AURION's Python, and whether the engine could actually start on it
# ---------------------------------------------------------------------------
# The question this answers is the one a first run fails on: is there an
# interpreter, and can it import what engine/requirements.txt asks for? Both
# halves are printed because the interesting failure is a machine that
# answers yes to the first and no to the second - which used to be reported
# as "that Python cannot import fastapi, numpy and sklearn" and nothing else.
Head "The engine's Python"

# Where the installation is, decided before anything needs it.
$folder = if ($own -and $own.InstallFolder) {
    $own.InstallFolder
} else {
    Join-Path $env:LOCALAPPDATA "Programs\AURION"
}

$privatePy = Join-Path $folder "runtime\python\python.exe"
$python = $null
if (Test-Path -LiteralPath $privatePy) {
    Good "AURION's own interpreter  $privatePy"
    $python = $privatePy
} else {
    Bad "AURION's own interpreter is missing  $privatePy"
    Say "The machine's own Python is used instead, if it is 3.10 to 3.12."
    foreach ($v in @("3.12", "3.11", "3.10")) {
        if (-not $python) {
            try {
                $out = & py "-$v" -c "import sys; print(sys.executable)" 2>$null
                if ($LASTEXITCODE -eq 0 -and $out) { $python = ([string]$out).Trim() }
            } catch { }
        }
    }
    if (-not $python) { $python = "python" }
}

# Run something and never let its stderr end this script.
#
# Windows PowerShell 5.1 turns a native program's stderr into a terminating
# error when $ErrorActionPreference is "Stop", and an interpreter with a
# missing library writes exactly there - so the check for the thing being
# diagnosed used to be the thing that killed the diagnosis.
#
# Arguments are an array, not a string: "-c" and its code are two words on a
# command line, and joining them hands Python one argument it does not know.
function Get-Quiet {
    param([string] $Program, [string[]] $Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $text = (& $Program @Arguments 2>&1 | Out-String)
        return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Text = ([string]$text).Trim() }
    } catch {
        return [pscustomobject]@{ Ok = $false; Text = "$_" }
    } finally {
        $ErrorActionPreference = $previous
    }
}

$version = Get-Quiet -Program $python -Arguments @("-V")
if ($version.Text) { Say "version   $($version.Text)" } else { Bad "that interpreter does not answer -V" }

$imports = Get-Quiet -Program $python -Arguments @(
    "-c", "import fastapi, numpy, sklearn, pandas, scipy, uvicorn")
if ($imports.Ok) {
    Good "the engine's libraries import"
} else {
    Bad "the engine's libraries do NOT import:"
    Say "fastapi, numpy, scikit-learn, pandas, scipy and uvicorn are what"
    Say "engine\requirements.txt asks for. To install them:"
    Say "  powershell -ExecutionPolicy Bypass -File scripts\fix-numpy.ps1"
    if ($imports.Text) {
        foreach ($line in ($imports.Text -split "`r?`n" | Select-Object -Last 4)) { Say "    $line" }
    }
}

$pip = Get-Quiet -Program $python -Arguments @("-m", "pip", "--version")
if ($pip.Ok) { Say "pip       $($pip.Text)" } else { Bad "pip       not available in that interpreter" }

$wheels = Join-Path $folder "vendor\wheels"
if (Test-Path -LiteralPath $wheels) {
    $count = @(Get-ChildItem -LiteralPath $wheels -Filter *.whl -ErrorAction SilentlyContinue).Count
    Say "bundled wheels  $count"
} else {
    Say "bundled wheels  none (this build did not carry them)"
}

# ---------------------------------------------------------------------------
# What the last setup said
# ---------------------------------------------------------------------------
# The one file that explains a first run that stopped before anything could
# log: setup writes every line here, including why it stopped.
Head "The last setup (data\logs\setup.log)"
$setupLog = Join-Path $folder "data\logs\setup.log"
if (Test-Path -LiteralPath $setupLog) {
    $tail = @(Get-Content -LiteralPath $setupLog -Tail 12 -ErrorAction SilentlyContinue)
    if ($tail.Count -eq 0) { Say "(empty)" }
    foreach ($line in $tail) { Say $line }
    Say ""
    Say "full log  $setupLog"
} else {
    Say "no setup has run in this installation"
}

Head "The uninstaller itself"
$exe = Join-Path $folder "AURION-Uninstall.exe"

if (Test-Path -LiteralPath $exe) {
    Good "present  $exe"
    Say ("{0:N1} MB" -f ((Get-Item -LiteralPath $exe).Length / 1MB))
} else {
    Bad "missing  $exe"
    Say "The installed build does not contain it."
}

Write-Host ""
