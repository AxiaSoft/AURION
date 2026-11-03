<#
.SYNOPSIS
    Diagnose and repair the product icon, then report. Paste-and-run.

.DESCRIPTION
    For the case where a build keeps failing with

        CSC : error CS7065: Error building Win32 resources --
              Icon stream is not in the expected format.

    and it is not clear whether the checkout is current, whether the icon is
    the problem, or whether the build is even running from the folder that
    was fixed. This answers all three and repairs what it can, printing what
    it found at every step so the output can be pasted back.

    Run it from anywhere; it works on the tree it is sitting in.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\fix-icon-now.ps1
#>
[CmdletBinding()]
param([switch]$SkipRepair)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$toolsDir = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $toolsDir "..\..")).Path
$icoPath  = Join-Path $repoRoot "installer\assets\generated\aurion.ico"

Write-Host ""
Write-Host "  AURION icon doctor" -ForegroundColor White
Write-Host "  ------------------" -ForegroundColor DarkGray
Write-Host ("  tree     {0}" -f $repoRoot) -ForegroundColor Gray

if (Test-Path (Join-Path $repoRoot ".git")) {
    $head = (& git -C $repoRoot log -1 --format="%h %s" 2>$null)
    $branch = (& git -C $repoRoot rev-parse --abbrev-ref HEAD 2>$null)
    Write-Host ("  commit   {0}" -f $head) -ForegroundColor Gray
    Write-Host ("  branch   {0}" -f $branch) -ForegroundColor Gray
} else {
    Write-Host "  commit   this folder is NOT a git checkout" -ForegroundColor Yellow
    Write-Host "           nothing pulled here will ever arrive - check you are" -ForegroundColor DarkYellow
    Write-Host "           building in the same folder you pull into." -ForegroundColor DarkYellow
}

if (-not (Test-Path $icoPath)) {
    Write-Host "  icon     MISSING" -ForegroundColor Red
    exit 1
}

function Show-Icon([string] $path) {
    $b = [System.IO.File]::ReadAllBytes($path)
    Write-Host ("  icon     {0:N0} bytes, first four 0x{1}" -f $b.Length,
        (($b | Select-Object -First 4 | ForEach-Object { $_.ToString("X2") }) -join " 0x")) -ForegroundColor Gray
    if ($b.Length -lt 6 -or $b[0] -ne 0 -or $b[1] -ne 0 -or $b[2] -ne 1 -or $b[3] -ne 0) {
        $kind = "an unrecognised format"
        if ($b[0] -eq 0x89 -and $b[1] -eq 0x50) { $kind = "a PNG" }
        elseif ($b[0] -eq 0xFF -and $b[1] -eq 0xD8) { $kind = "a JPEG" }
        elseif ($b[0] -eq 0x42 -and $b[1] -eq 0x4D) { $kind = "a BMP" }
        Write-Host ("           this is {0}, not an icon container" -f $kind) -ForegroundColor Yellow
        return $false
    }
    $n = [BitConverter]::ToUInt16($b, 4)
    $dims = @()
    for ($i = 0; $i -lt $n; $i++) {
        $w = $b[6 + $i * 16]
        $dims += $(if ($w -eq 0) { 256 } else { [int]$w })
    }
    Write-Host ("           {0} image(s): {1}" -f $n, ($dims -join ", ")) -ForegroundColor Gray
    $small = @($dims | Where-Object { $_ -le 64 }).Count
    if ($n -lt 2 -or $small -lt 1) {
        Write-Host "           no small sizes - some toolchains refuse this shape" -ForegroundColor Yellow
        return $false
    }
    return $true
}

$good = Show-Icon $icoPath
if ($good) {
    Write-Host ""
    Write-Host "  The icon is fine. If the build still fails with CS7065, it is not" -ForegroundColor Green
    Write-Host "  building from this folder - compare the path printed above with" -ForegroundColor Green
    Write-Host "  the one in the build log." -ForegroundColor Green
    exit 0
}

if ($SkipRepair) { exit 1 }

Write-Host ""
Write-Host "  repairing..." -ForegroundColor Cyan
$stash = Join-Path (Split-Path $icoPath) "aurion.original.png"
Copy-Item -LiteralPath $icoPath -Destination $stash -Force
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $toolsDir "make-icon.ps1") `
    -Source $stash -Destination $icoPath

Write-Host ""
if (Show-Icon $icoPath) {
    Write-Host ""
    Write-Host "  Repaired. Run the build again." -ForegroundColor Green
    exit 0
}
Write-Host "  Could not repair it automatically." -ForegroundColor Red
exit 1
