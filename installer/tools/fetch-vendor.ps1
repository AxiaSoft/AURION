<#
.SYNOPSIS
    Download the runtimes AURION needs, at build time, so the MSI carries
    them and a customer's machine never has to fetch anything.

.DESCRIPTION
    Everything AURION runs on used to be downloaded on the customer's
    machine, on first run. That is the wrong machine to be doing it on. It
    is the one nobody can log into, the one behind the corporate proxy, the
    one where a failed download turns into "the desk does not start" and
    somebody else's afternoon.

    This runs on the build machine instead, where there is a developer, a
    console and a working network. What it produces is copied into the MSI
    by stage.ps1 and used in preference to the network by both the setup
    window and scripts\provision.ps1.

        installer\vendor\
            python-3.12.7-amd64.exe          25 MB
            node-v20.17.0-win-x64.zip        30 MB
            SHASUMS256.txt                   the checksum list for the zip
            MicrosoftEdgeWebview2Setup.exe    2 MB
            wheels\*.whl                     ~90 MB, optional

    The verification is the same as it would have been on the customer's
    machine - Authenticode for the signed installers, the vendor's published
    SHA-256 for the zip - just done once, here, by somebody who can read the
    error.

    Already-downloaded files are left alone, so this is cheap to re-run and
    does not re-fetch 150 MB on every build.

.PARAMETER Destination
    Where to put them. Defaults to installer\vendor.

.PARAMETER SkipWheels
    Do not collect the engine's Python wheels. The wheels are the only part
    that needs a Python on the build machine; without them a customer's
    machine still has to reach PyPI, but nothing else.

.PARAMETER Force
    Re-download even when the file is already there.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\fetch-vendor.ps1
#>

[CmdletBinding()]
param(
    [string] $Destination = "",
    [switch] $SkipWheels,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$installerDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot     = (Resolve-Path (Join-Path $installerDir "..")).Path
if (-not $Destination) { $Destination = Join-Path $installerDir "vendor" }
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

# These three constants are the contract with Prerequisites.cs and
# provision.ps1: they look for these exact filenames. A test keeps the
# versions in step.
$PythonVersion   = "3.12.7"
$PythonExeName   = "python-$PythonVersion-amd64.exe"
$PythonUrl       = "https://www.python.org/ftp/python/$PythonVersion/$PythonExeName"
$PythonPublisher = "Python Software Foundation"

$NodeVersion = "v20.17.0"
$NodeZipName = "node-$NodeVersion-win-x64.zip"
$NodeZipUrl  = "https://nodejs.org/dist/$NodeVersion/$NodeZipName"
$NodeSumsUrl = "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt"

$WebViewName      = "MicrosoftEdgeWebview2Setup.exe"
$WebViewUrl       = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
$WebViewPublisher = "Microsoft Corporation"

function Say { param([string] $T) Write-Host "  $T" }
function Head { param([string] $T) Write-Host ""; Write-Host $T -ForegroundColor Cyan }

function Get-Vendor {
    param([string] $Url, [string] $Name)

    $target = Join-Path $Destination $Name
    if ((Test-Path -LiteralPath $target) -and -not $Force) {
        Say ("{0} already here, {1:N1} MB" -f $Name, ((Get-Item -LiteralPath $target).Length / 1MB))
        return $target
    }

    Say "downloading $Name ..."
    $previous = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        # Written to a .part first: a half-finished file left behind by an
        # interrupted build would be treated as cached by the next one.
        Invoke-WebRequest -Uri $Url -OutFile "$target.part" -UseBasicParsing
    } finally {
        $ProgressPreference = $previous
    }
    Move-Item -LiteralPath "$target.part" -Destination $target -Force
    Say ("{0} downloaded, {1:N1} MB" -f $Name, ((Get-Item -LiteralPath $target).Length / 1MB))
    return $target
}

function Assert-SignedBy {
    param([string] $Path, [string] $Publisher)

    $sig = Get-AuthenticodeSignature -LiteralPath $Path
    $subject = ""
    if ($sig.SignerCertificate) { $subject = $sig.SignerCertificate.Subject }
    if ($sig.Status -ne "Valid" -or $subject -notlike "*$Publisher*") {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw "$(Split-Path -Leaf $Path) is not validly signed by $Publisher. It was deleted, not bundled."
    }
    Say "signature verified: $Publisher"
}

Head "Collecting the runtimes AURION ships with"
Say "into $Destination"

# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------
Head "Python $PythonVersion"
$py = Get-Vendor -Url $PythonUrl -Name $PythonExeName
Assert-SignedBy -Path $py -Publisher $PythonPublisher

# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------
Head "Node.js $NodeVersion"
$zip = Get-Vendor -Url $NodeZipUrl -Name $NodeZipName

# The checksum file is bundled alongside the zip rather than only checked
# here, so the customer's machine can verify what it unpacks without needing
# nodejs.org to be reachable.
$sumsPath = Join-Path $Destination "SHASUMS256.txt"
Invoke-WebRequest -Uri $NodeSumsUrl -OutFile $sumsPath -UseBasicParsing
$wanted = Get-Content -LiteralPath $sumsPath |
          ForEach-Object { $_.Trim() } |
          Where-Object { $_ -match "[\s\*]$([regex]::Escape($NodeZipName))$" } |
          Select-Object -First 1
if (-not $wanted) { throw "$NodeZipName is not listed in the vendor's checksum file." }

$expected = ($wanted -split '\s+')[0]
$actual   = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
if ($actual -ne $expected.ToUpperInvariant()) {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    throw "$NodeZipName does not match its published SHA-256. It was deleted, not bundled."
}
Say "checksum verified against nodejs.org"

# ---------------------------------------------------------------------------
# WebView2
# ---------------------------------------------------------------------------
Head "WebView2 runtime bootstrapper"
$wv = Get-Vendor -Url $WebViewUrl -Name $WebViewName
Assert-SignedBy -Path $wv -Publisher $WebViewPublisher

# ---------------------------------------------------------------------------
# The engine's Python wheels
# ---------------------------------------------------------------------------
# This is the only part that needs a Python here. --only-binary and the
# explicit platform are what make the result usable on a machine that has no
# compiler: pip must not fall back to a source distribution it would then try
# to build on the customer's laptop.
if ($SkipWheels) {
    Head "Wheels skipped (-SkipWheels)"
    Say "a bare machine will still have to reach PyPI for the engine libraries"
} else {
    Head "Engine wheels"
    $requirements = Join-Path $repoRoot "engine\requirements.txt"
    if (-not (Test-Path -LiteralPath $requirements)) {
        Say "engine\requirements.txt is missing - skipping"
    } else {
        $pip = $null
        foreach ($v in @("3.12", "3.11", "3.10")) {
            try {
                $null = & py "-$v" -c "import sys" 2>$null
                if ($LASTEXITCODE -eq 0) { $pip = @("py", "-$v"); break }
            } catch { }
        }
        if (-not $pip) {
            try {
                $null = & python -c "import sys" 2>$null
                if ($LASTEXITCODE -eq 0) { $pip = @("python") }
            } catch { }
        }

        if (-not $pip) {
            Say "no Python on this build machine - skipping the wheels" 
            Say "the MSI will still work; the engine libraries will come from PyPI on first run"
        } else {
            $wheels = Join-Path $Destination "wheels"
            New-Item -ItemType Directory -Path $wheels -Force | Out-Null
            Say "collecting wheels with $($pip -join ' ') ..."

            # pip writes progress to stderr even when it succeeds.
            $previousEap = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try {
                & $pip[0] @($pip[1..($pip.Length - 1)]) -m pip download `
                    -r $requirements --dest $wheels `
                    --only-binary=:all: --platform win_amd64 --python-version 3.12 2>&1 |
                    ForEach-Object { Write-Verbose "$_" }
                $code = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousEap
            }

            if ($code -ne 0) {
                # Not fatal. A bundle without wheels is still a better
                # installer than no bundle, and failing the whole build over
                # an optional optimisation would be the wrong trade.
                Say "pip download failed with code $code - continuing without wheels" 
                Remove-Item -LiteralPath $wheels -Recurse -Force -ErrorAction SilentlyContinue
            } else {
                $n = (Get-ChildItem -LiteralPath $wheels -Filter *.whl -ErrorAction SilentlyContinue).Count
                Say "$n wheels collected"
            }
        }
    }
}

# ---------------------------------------------------------------------------
# What the build is about to ship
# ---------------------------------------------------------------------------
Head "Bundle"
$total = 0
Get-ChildItem -LiteralPath $Destination -Recurse -File | ForEach-Object { $total += $_.Length }
Get-ChildItem -LiteralPath $Destination -File |
    Sort-Object Name |
    ForEach-Object { Say ("{0,-40} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB)) }
$wheelDir = Join-Path $Destination "wheels"
if (Test-Path -LiteralPath $wheelDir) {
    $wSize = 0
    Get-ChildItem -LiteralPath $wheelDir -File | ForEach-Object { $wSize += $_.Length }
    Say ("{0,-40} {1,8:N1} MB" -f "wheels\", ($wSize / 1MB))
}
Write-Host ""
Write-Host ("Total bundled: {0:N1} MB" -f ($total / 1MB)) -ForegroundColor Green
Write-Host "A machine installing this MSI needs nothing from the network." -ForegroundColor Green
