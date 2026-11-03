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
Head "The uninstaller itself"
$folder = if ($own -and $own.InstallFolder) {
    $own.InstallFolder
} else {
    Join-Path $env:LOCALAPPDATA "Programs\AURION"
}
$exe = Join-Path $folder "AURION-Uninstall.exe"

if (Test-Path -LiteralPath $exe) {
    Good "present  $exe"
    Say ("{0:N1} MB" -f ((Get-Item -LiteralPath $exe).Length / 1MB))
} else {
    Bad "missing  $exe"
    Say "The installed build does not contain it."
}

Write-Host ""
