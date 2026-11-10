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
            python-3.12.7-embed-amd64.zip    11 MB, the fallback interpreter
            get-pip.py                       pip, carried inside it
            runtime-python.zip                Python with the engine's
                                              libraries already installed
            node-v20.17.0-win-x64.zip        30 MB
            SHASUMS256.txt                   the checksum list for the zip
            MicrosoftEdgeWebview2Setup.exe    2 MB
            wheels\*.whl                     ~90 MB, optional

    runtime-python.zip is the difference between "the target machine does
    not download anything" and "the target machine does not download anything
    and does not spend two minutes installing either". prepare-runtime.ps1
    unpacks the embeddable Python, installs every library into it from
    wheels\, and packages the result: the installer then unzips one file and
    is finished. wheels\ stays alongside it so a repair can still run pip
    offline, and so a build without the prepared runtime is still complete.

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

.PARAMETER SkipRuntime
    Do not build runtime-python.zip. The installer still installs the engine's
    libraries from wheels\, offline - the difference is that it does the
    unpacking on the target machine instead of shipping the result.

.PARAMETER Force
    Re-download even when the file is already there.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\fetch-vendor.ps1
#>

[CmdletBinding()]
param(
    [string] $Destination = "",
    [switch] $SkipWheels,
    [switch] $SkipRuntime,
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

# The same Python, as a zip.
#
# The .exe above is an MSI bundle, and on a customer's machine that turned
# out to be the difference between Node installing and Python not: Windows
# allows one installation at a time, a desk launched from its own MSI's
# finish page races the installer that started it, and the bundle exits
# with a number and no explanation. The embeddable build is just files.
# Unpacking it answers to nobody, needs no administrator, and is exactly
# how Node is installed here - which works.
#
# It ships alongside the .exe rather than instead of it. The full installer
# is still tried first, because it brings a complete standard library and a
# real pip; this is what happens when it will not run at all.
$PythonZipName = "python-$PythonVersion-embed-amd64.zip"
$PythonZipUrl  = "https://www.python.org/ftp/python/$PythonVersion/$PythonZipName"

# The embeddable build deliberately ships without pip. get-pip.py carries
# its own copy of pip inside it, so this works with no network.
$GetPipName = "get-pip.py"
$GetPipUrl  = "https://bootstrap.pypa.io/get-pip.py"

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

    # Retried, because one refused connection should not cost a build.
    #
    # A build that already has 139 MB of verified payload on disk died on a
    # 4 KB text file, and reported it as a raw Invoke-WebRequest stack
    # trace. Three attempts with a widening pause covers the transient
    # refusals; anything that survives all three is a real network problem
    # and is reported as one.
    $attempts = 3
    for ($try = 1; $try -le $attempts; $try++) {
        try {
            # Written to a .part first: a half-finished file left behind by
            # an interrupted build would be treated as cached by the next.
            Invoke-WebRequest -Uri $Url -OutFile "$target.part" -UseBasicParsing -TimeoutSec 120
            break
        } catch {
            Remove-Item -LiteralPath "$target.part" -Force -ErrorAction SilentlyContinue
            if ($try -eq $attempts) {
                $ProgressPreference = $previous
                throw ("Could not download $Name after $attempts attempts.`n" +
                       "  $Url`n" +
                       "  $($_.Exception.Message)`n" +
                       "  If this machine cannot reach the internet, fetch the file by hand into`n" +
                       "  $Destination and run the build again - anything already there is reused.")
            }
            Say "attempt $try failed, retrying in $($try * 3)s ..."
            Start-Sleep -Seconds ($try * 3)
        }
    }

    $ProgressPreference = $previous
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

# The fallback, and the thing that makes it usable.
$zip = Get-Vendor -Url $PythonZipUrl -Name $PythonZipName
if ((Get-Item -LiteralPath $zip).Length -lt 5MB) {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    throw "$PythonZipName is too small to be the embeddable Python. It was deleted, not bundled."
}

$getPip = Get-Vendor -Url $GetPipUrl -Name $GetPipName
if ((Get-Item -LiteralPath $getPip).Length -lt 100KB) {
    Remove-Item -LiteralPath $getPip -Force -ErrorAction SilentlyContinue
    throw "$GetPipName is too small to contain pip. It was deleted, not bundled."
}

# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------
Head "Node.js $NodeVersion"
$zip = Get-Vendor -Url $NodeZipUrl -Name $NodeZipName

# The checksum file is bundled alongside the zip rather than only checked
# here, so the customer's machine can verify what it unpacks without needing
# nodejs.org to be reachable.
#
# Cached like everything else. This was the one file fetched unconditionally
# on every build, and it is the smallest thing in the bundle: a build with
# all 139 MB already downloaded and verified still died here because
# nodejs.org refused a connection for a few seconds.
$sumsPath = Get-Vendor -Url $NodeSumsUrl -Name "SHASUMS256.txt"
$wanted = Get-Content -LiteralPath $sumsPath |
          ForEach-Object { $_.Trim() } |
          Where-Object { $_ -match "[\s\*]$([regex]::Escape($NodeZipName))$" } |
          Select-Object -First 1
if (-not $wanted) { throw "$NodeZipName is not listed in the vendor's checksum file." }

$expected = ($wanted -split '\s+')[0]
$actual   = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
if ($actual -ne $expected.ToUpperInvariant()) {
    # Both files are cached, so a mismatch is as likely to be a stale
    # checksum list as a bad zip. Delete both and let the next run decide
    # with two fresh files, rather than accusing the zip on this evidence.
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $sumsPath -Force -ErrorAction SilentlyContinue
    throw ("$NodeZipName does not match the SHA-256 published for it.`n" +
           "  Both it and SHASUMS256.txt were deleted. Run the build again to re-fetch them.")
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
            # Not a warning any more. A bundle without wheels is a bundle
            # that needs the CUSTOMER's network to reach PyPI, and the one
            # that shipped without them produced exactly that support call:
            # a bare machine, four attempts, "could not install the engine's
            # libraries", and no way forward. If that trade is wanted it has
            # to be asked for, by name.
            throw ("No Python on this build machine, so the engine's wheels cannot be collected.`n" +
                   "  Install CPython 3.12 here, or build with -SkipWheels to ship a bundle that`n" +
                   "  downloads the engine's libraries on the customer's machine instead.")
        } else {
            $wheels = Join-Path $Destination "wheels"
            New-Item -ItemType Directory -Path $wheels -Force | Out-Null
            Say "collecting wheels with $($pip -join ' ') ..."

            # pip writes progress to stderr even when it succeeds.
            #
            # The interpreter's own switches are collected with a count check
            # rather than [1..(Length - 1)]: on a build machine with no `py`
            # launcher, $pip is a one-element array, and that range is then
            # 1..0 - which PowerShell reads as 1, 0 and hands pip a command
            # line beginning with an empty argument. Every wheel collection
            # failed that way, was swallowed by the "not fatal" branch below,
            # and shipped an MSI whose promise of working offline was empty.
            $tail = @()
            if ($pip.Count -gt 1) { $tail = @($pip[1..($pip.Count - 1)]) }

            $previousEap = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try {
                & $pip[0] @tail -m pip download `
                    -r $requirements --dest $wheels `
                    --only-binary=:all: --platform win_amd64 --python-version 3.12 2>&1 |
                    ForEach-Object { Write-Verbose "$_" }
                $code = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousEap
            }

            if ($code -ne 0) {
                # Fatal. The half-bundle is indistinguishable from a good one
                # until it is on somebody else's computer with no internet,
                # which is the machine this whole bundle exists for.
                Remove-Item -LiteralPath $wheels -Recurse -Force -ErrorAction SilentlyContinue
                throw ("pip download failed with code $code, so the engine's wheels are not in the bundle.`n" +
                       "  Fix the download here, or build with -SkipWheels to ship without them deliberately.")
            }
            $n = (Get-ChildItem -LiteralPath $wheels -Filter *.whl -ErrorAction SilentlyContinue).Count
            if ($n -lt 1) {
                throw "pip reported success but no wheels landed in $wheels."
            }
            Say "$n wheels collected"

            # MetaTrader5, by name.
            #
            # It is commented out of requirements.txt because the engine has
            # to run on Linux, where the package does not exist - and
            # scripts\start.ps1 fetched it from PyPI on the customer's machine
            # at first run, which is precisely the download this build is
            # meant to remove. Without it the desk starts and cannot reach the
            # terminal, so it is worth a second pip call rather than leaving
            # it to the repair screen.
            Say "collecting the MetaTrader5 wheel ..."
            $previousEap = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try {
                & $pip[0] @tail -m pip download "MetaTrader5" --dest $wheels `
                    --only-binary=:all: --platform win_amd64 --python-version 3.12 2>&1 |
                    ForEach-Object { Write-Verbose "$_" }
                $mt5Code = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousEap
            }
            if ($mt5Code -ne 0) {
                # Not fatal, and genuinely optional: the desk starts without
                # it and says the terminal is unavailable, which is a state
                # the product already handles.
                Say "MetaTrader5 is not on PyPI for this platform - the desk will start"
                Say "and the terminal will be unavailable until it is installed"
            } else {
                Say "MetaTrader5 collected"
            }

            # pip's own wheel.
            #
            # The embeddable Python has no pip and no ensurepip, so a bare
            # machine has to get one from somewhere before it can install
            # anything from wheels\. Until this was bundled, "somewhere" was
            # get-pip.py - which carries pip but, left to its defaults, also
            # fetches setuptools and wheel from PyPI. A customer with working
            # internet and an unreachable index got a network error from the
            # one step that was supposed to prove the network was not needed,
            # and the thirty wheels beside it were never tried.
            #
            # A wheel is a zip with the package at its root, so the installer
            # can run this file to install itself: no index, no get-pip, no
            # network. Fatal, like the wheels above, because a bundle without
            # it is a bundle that works on machines like this one and fails
            # on the machines it exists for.
            Say "collecting pip's own wheel ..."
            $previousEap = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            try {
                & $pip[0] @tail -m pip download "pip" --dest $wheels `
                    --only-binary=:all: --python-version 3.12 2>&1 |
                    ForEach-Object { Write-Verbose "$_" }
                $pipCode = $LASTEXITCODE
            } finally {
                $ErrorActionPreference = $previousEap
            }
            # pip-24.2-py3-none-any.whl, not pipdeptree: the character after
            # the dash has to be a digit.
            $pipWheel = @(Get-ChildItem -LiteralPath $wheels -Filter "pip-*.whl" -File -ErrorAction SilentlyContinue |
                          Where-Object { $_.Name -match "^pip-[0-9]" })
            if ($pipCode -ne 0 -or $pipWheel.Count -eq 0) {
                throw ("pip's own wheel could not be collected, so a machine with no pip`n" +
                       "  would have to reach PyPI before it could use any of the wheels`n" +
                       "  beside it. Fix the download here, or build with -SkipWheels to`n" +
                       "  ship without the offline path deliberately.")
            }
            Say "pip wheel collected ($($pipWheel[0].Name))"
        }
    }
}

# ---------------------------------------------------------------------------
# The interpreter, with the libraries already installed
# ---------------------------------------------------------------------------
# This is what takes the last slow step off the customer's machine. Without
# it the installer still needs no network - it unpacks the embeddable Python
# and runs pip against wheels\ - but it spends a minute or two of a first run
# doing work that could have been done here, once, and it is one more place
# where a machine can differ from this one.
$hasRuntimeInputs = (Test-Path -LiteralPath (Join-Path $Destination $PythonZipName)) -and
                    (Test-Path -LiteralPath (Join-Path $Destination $GetPipName)) -and
                    (@(Get-ChildItem -LiteralPath (Join-Path $Destination "wheels") -Filter *.whl -File -ErrorAction SilentlyContinue).Count -gt 0)

if ($SkipRuntime) {
    Head "Python runtime skipped (-SkipRuntime)"
    Say "the target machine will install the engine's libraries from wheels\ itself"
} elseif (-not $hasRuntimeInputs) {
    Head "No prebuilt Python runtime"
    Say "the interpreter or the wheels are not here, so there is nothing to build it from"
    Say "the installer will still work offline: it unpacks Python and installs the wheels"
} else {
    & (Join-Path $PSScriptRoot "prepare-runtime.ps1") -Vendor $Destination -Root $repoRoot -Force:$Force
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
