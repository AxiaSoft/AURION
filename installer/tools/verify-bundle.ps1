<#
.SYNOPSIS
    Decide whether the MSI you just built will install on a machine with no
    Python, no Node and no network - without needing such a machine.

.DESCRIPTION
    "It built without errors" and "it installs on a bare PC" are different
    claims, and only the second one matters to the person receiving it. A
    build can finish perfectly and still ship a wheel that was truncated
    while it was being written, or a bundle missing the one library nobody
    imports until the engine starts.

    This checks the five things that decide it, on the build machine, in
    about a minute:

      1. Inventory. Every runtime the installer expects, with its size, and
         which of the two first-run paths the customer actually gets.
      2. Integrity. Every .whl is opened as an archive and its METADATA
         read; the Node zip is checked against the SHA-256 nodejs.org
         published; the signed installers are checked against their
         Authenticode signature. A file that was damaged after it was
         downloaded - by a scanner, a sync client, a disk - is found here
         rather than on the customer's first run.
      3. Coverage. Every requirement in engine\requirements.txt has a wheel
         in the bundle to satisfy it from.
      4. The customer's own install, simulated. The exact offline pip
         command the setup window runs, into a temporary folder, against
         the bundle. If this passes, the step that failed on the bare
         machine passes.
      5. The MSI itself: size, SHA-256, and agreement with the .sha256 file
         beside it.

    It reads. It writes nothing except a temporary folder it then deletes,
    and it needs no administrator.

    A verdict at the end, and an exit code: 0 means the bundle installs
    with nothing from the network.

.PARAMETER Vendor
    The bundle to check. Defaults to installer\vendor.

.PARAMETER Msi
    The finished installer, to hash and size. Optional.

.PARAMETER SkipInstallTest
    Skip step 4 (the only step that needs a Python 3.12 on this machine).
    The other four still run.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\verify-bundle.ps1

.EXAMPLE
    .\verify-bundle.ps1 -Msi installer\output\AURION-1.0.0-x64.msi
#>

[CmdletBinding()]
param(
    [string] $Vendor = "",
    [string] $Msi    = "",
    [string] $Root   = "",
    [switch] $SkipInstallTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Head([string] $msg) { Write-Host ""; Write-Host $msg -ForegroundColor Cyan }
function Say ([string] $msg) { Write-Host "  $msg" }
function Good([string] $msg) { Write-Host "  $msg" -ForegroundColor Green }
function Warn([string] $msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Fail([string] $msg) { Write-Host "  $msg" -ForegroundColor Red }

$installerDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Root)   { $Root   = (Resolve-Path (Join-Path $installerDir "..")).Path }
if (-not $Vendor) { $Vendor = Join-Path $installerDir "vendor" }
if (-not (Test-Path -LiteralPath $Vendor)) {
    throw "No bundle at $Vendor. Run installer\tools\fetch-vendor.ps1 first."
}
$Vendor = (Resolve-Path -LiteralPath $Vendor).Path
$requirements = Join-Path $Root "engine\requirements.txt"
$wheelDir = Join-Path $Vendor "wheels"

Add-Type -AssemblyName System.IO.Compression.FileSystem

$problems = @()
$notes    = @()

Write-Host ""
Write-Host "  AURION bundle verification" -ForegroundColor White
Write-Host "  --------------------------" -ForegroundColor DarkGray
Say "bundle $Vendor"

# ---------------------------------------------------------------------------
# 1. Inventory
# ---------------------------------------------------------------------------
Head "What the bundle carries"

$runtimeZip = Join-Path $Vendor "runtime-python.zip"
$hasPrepared = Test-Path -LiteralPath $runtimeZip

# Required, unless the prepared runtime replaces them: stage.ps1 drops the
# installer and the embeddable zip when runtime-python.zip is there, because
# the prepared runtime is those two with the libraries already inside.
$required = @("node-v20.17.0-win-x64.zip", "SHASUMS256.txt", "MicrosoftEdgeWebview2Setup.exe")
if (-not $hasPrepared) { $required += "python-3.12.7-embed-amd64.zip", "get-pip.py" }

foreach ($name in $required) {
    $path = Join-Path $Vendor $name
    if (Test-Path -LiteralPath $path) {
        Say ("{0,-40} {1,8:N1} MB" -f $name, ((Get-Item -LiteralPath $path).Length / 1MB))
    } else {
        Fail ("{0,-40} MISSING" -f $name)
        $problems += "$name is not in the bundle"
    }
}

if ($hasPrepared) {
    Good ("{0,-40} {1,8:N1} MB" -f "runtime-python.zip", ((Get-Item -LiteralPath $runtimeZip).Length / 1MB))
    $notes += "First run unzips the prepared runtime: seconds, no pip."
} else {
    Warn ("{0,-40} {1}" -f "runtime-python.zip", "not in this bundle")
    $notes += "First run installs the libraries from vendor\wheels with pip: about two minutes, still no network."
}

$wheels = @()
if (Test-Path -LiteralPath $wheelDir) {
    $wheels = @(Get-ChildItem -LiteralPath $wheelDir -Filter *.whl -File -ErrorAction SilentlyContinue)
}
if ($wheels.Count -gt 0) {
    Say ("{0,-40} {1,8:N1} MB  ({2} files)" -f "wheels\", ((($wheels | Measure-Object Length -Sum).Sum) / 1MB), $wheels.Count)
} elseif (-not $hasPrepared) {
    Fail ("{0,-40} EMPTY" -f "wheels\")
    $problems += "no wheels and no prepared runtime: the customer's machine would have to reach PyPI"
} else {
    Warn "wheels\ is empty - the prepared runtime covers the first run, but a repair could not run pip offline"
}

# ---------------------------------------------------------------------------
# 2. Integrity
# ---------------------------------------------------------------------------
# Not paranoia. On this build machine something removed files out of the
# runtime folder twice while a build was running, and a wheel that was being
# written at that moment would be a truncated archive that pip rejects on
# the customer's first run with an error nobody can act on.
Head "Is every file intact"

$badWheels = @()
foreach ($wheel in $wheels) {
    if ($wheel.Length -lt 1024) { $badWheels += "$($wheel.Name) (only $($wheel.Length) bytes)"; continue }
    try {
        $zip = [System.IO.Compression.ZipFile]::OpenRead($wheel.FullName)
        try {
            $meta = @($zip.Entries | Where-Object { $_.FullName -like "*.dist-info/METADATA" })
            if ($meta.Count -eq 0) { $badWheels += "$($wheel.Name) (no METADATA inside)" }
            elseif ($meta[0].Length -le 0) { $badWheels += "$($wheel.Name) (empty METADATA)" }
        } finally {
            $zip.Dispose()
        }
    } catch {
        $badWheels += "$($wheel.Name) (not a readable archive: $($_.Exception.Message))"
    }
}
if ($wheels.Count -gt 0) {
    if ($badWheels.Count -eq 0) {
        Good "all $($wheels.Count) wheels open and carry their metadata"
    } else {
        foreach ($b in $badWheels) { Fail $b }
        $problems += "$($badWheels.Count) wheel(s) are damaged - delete vendor\wheels and run fetch-vendor.ps1 again"
    }
}

# The Node zip against the checksum nodejs.org published, which is the whole
# point of shipping SHASUMS256.txt next to it.
$nodeZip = Join-Path $Vendor "node-v20.17.0-win-x64.zip"
$sums    = Join-Path $Vendor "SHASUMS256.txt"
if ((Test-Path -LiteralPath $nodeZip) -and (Test-Path -LiteralPath $sums)) {
    $expected = ""
    foreach ($line in (Get-Content -LiteralPath $sums)) {
        if ($line -match "^([0-9a-fA-F]{64})\s+\*?node-v20\.17\.0-win-x64\.zip\s*$") { $expected = $Matches[1].ToLowerInvariant() }
    }
    if (-not $expected) {
        Warn "SHASUMS256.txt does not list node-v20.17.0-win-x64.zip"
    } else {
        $actual = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -eq $expected) { Good "node-v20.17.0-win-x64.zip matches the checksum nodejs.org published" }
        else {
            Fail "node-v20.17.0-win-x64.zip does NOT match SHASUMS256.txt"
            $problems += "the Node zip is damaged - delete it and run fetch-vendor.ps1 again"
        }
    }
}

# The signed installers, by their signature rather than by their size.
foreach ($signed in @("python-3.12.7-amd64.exe", "MicrosoftEdgeWebview2Setup.exe")) {
    $path = Join-Path $Vendor $signed
    if (-not (Test-Path -LiteralPath $path)) { continue }
    try {
        $sig = Get-AuthenticodeSignature -LiteralPath $path
        if ($sig.Status -eq "Valid") { Good "$signed is signed: $($sig.SignerCertificate.Subject.Split(',')[0])" }
        else {
            Fail "$signed signature is $($sig.Status)"
            $problems += "$signed is not intact"
        }
    } catch {
        Warn "$signed could not be checked: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# 3. Coverage
# ---------------------------------------------------------------------------
Head "Does the bundle cover engine\requirements.txt"

function Normalise([string] $name) { return $name.Trim().ToLowerInvariant().Replace("_", "-") }

$needed = @()
if (Test-Path -LiteralPath $requirements) {
    foreach ($line in (Get-Content -LiteralPath $requirements)) {
        $text = $line.Trim()
        if (-not $text -or $text.StartsWith("#")) { continue }
        $name = ($text -split "[=<>!;~\[]")[0]
        if ($name) { $needed += (Normalise $name) }
    }
} else {
    $problems += "engine\requirements.txt is not at $requirements"
}

$have = @{}
foreach ($wheel in $wheels) { $have[(Normalise ($wheel.Name -split "-")[0])] = $true }

$uncovered = @()
foreach ($name in $needed) { if (-not $have.ContainsKey($name)) { $uncovered += $name } }

if ($needed.Count -eq 0) {
    Warn "nothing to check"
} elseif ($wheels.Count -eq 0 -and $hasPrepared) {
    Say "no wheels, but the prepared runtime already contains the libraries"
} elseif ($uncovered.Count -eq 0) {
    Good "all $($needed.Count) requirements have a wheel in the bundle"
} else {
    foreach ($u in $uncovered) { Fail "no wheel for $u" }
    $problems += "$($uncovered.Count) requirement(s) have no wheel: the customer's machine would reach PyPI for them"
}

# MetaTrader5 is deliberately not in requirements.txt - the engine runs on
# Linux too - but without it the desk starts and cannot reach the terminal.
if ($have.ContainsKey("metatrader5")) { Good "MetaTrader5 is bundled" }
else { Warn "no MetaTrader5 wheel: the desk will start and the terminal will be unavailable" }

# ---------------------------------------------------------------------------
# 4. The customer's install, simulated
# ---------------------------------------------------------------------------
Head "Installing the way the customer's machine will"

# $x[1..($x.Count - 1)] on a one-element array is the range 1..0, which
# PowerShell reads as "1, then 0" - descending - and hands the command its
# own name as an argument. provision.ps1 shipped that bug once; it is not
# being written a second time.
function Find-Python312 {
    $candidates = @()
    $candidates += ,@("py", "-3.12")
    $candidates += ,@("python")
    foreach ($candidate in $candidates) {
        $exe = $candidate[0]
        $pre = @()
        if ($candidate.Count -gt 1) { $pre = @($candidate[1..($candidate.Count - 1)]) }
        try {
            $global:LASTEXITCODE = -1
            $probe = & $exe @($pre + @("-c", "import sys;print(sys.version_info[:2])")) 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0 -and $probe -match "\(3, 1[012]\)") { return ,(@($exe) + $pre) }
        } catch {
            # py.exe answers "3.12 is not installed" on stderr, which with
            # ErrorActionPreference Stop arrives here as an exception. It is
            # an answer, not a failure.
        }
    }
    return @()
}

if ($SkipInstallTest) {
    Warn "skipped (-SkipInstallTest)"
    $notes += "The offline install was not simulated, so this run did not prove the bundle installs."
} elseif ($wheels.Count -eq 0) {
    Warn "no wheels to install from - nothing to simulate"
} else {
    $python = Find-Python312
    $pre = @()
    if ($python.Count -gt 1) { $pre = @($python[1..($python.Count - 1)]) }
    if ($python.Count -eq 0) {
        Warn "no Python 3.10-3.12 on this machine, so the install could not be simulated"
        $notes += "Install Python 3.12 here and run this again to prove the bundle before shipping it."
    } else {
        $target = Join-Path ([System.IO.Path]::GetTempPath()) ("aurion-verify-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
        Say "into $target"
        Say "(--no-index: if this needs the network, it fails rather than hiding it)"
        # Not $args: that is an automatic variable, and overwriting it is how
        # a script starts arguing with PowerShell about its own parameters.
        $pipArgs = $pre + @(
            "-m", "pip", "install",
            "-r", $requirements,
            "--no-index", "--find-links", $wheelDir,
            "--target", $target,
            "--only-binary=:all:", "--no-cache-dir",
            "--disable-pip-version-check", "--no-input")
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $global:LASTEXITCODE = -1
        try {
            $out = & $python[0] @pipArgs 2>&1 | Out-String
            $code = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $previousEap
        }

        if ($code -eq 0) {
            $installed = @(Get-ChildItem -LiteralPath $target -Directory -ErrorAction SilentlyContinue |
                           Where-Object { $_.Name -like "*.dist-info" })
            Good "pip installed every requirement from the bundle, offline ($($installed.Count) packages)"
        } else {
            Fail "pip could not install the engine's libraries from this bundle (exit $code)"
            $tail = ($out.Trim() -split "`r?`n" | Select-Object -Last 15) -join [Environment]::NewLine
            Write-Host $tail -ForegroundColor Red
            $problems += "the offline install failed here, so it will fail on the customer's machine"
        }
        Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------------------
# 5. The installer itself
# ---------------------------------------------------------------------------
if ($Msi) {
    Head "The MSI"
    if (-not (Test-Path -LiteralPath $Msi)) {
        Fail "not found: $Msi"
        $problems += "the MSI named on the command line is not there"
    } else {
        $msiItem = Get-Item -LiteralPath $Msi
        Say ("{0}  {1:N1} MB" -f $msiItem.Name, ($msiItem.Length / 1MB))
        $hash = (Get-FileHash -LiteralPath $msiItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        Say "sha256 $hash"

        $sidecar = $msiItem.FullName + ".sha256"
        if (Test-Path -LiteralPath $sidecar) {
            $recorded = ((Get-Content -LiteralPath $sidecar -Raw) -split "\s+")[0].ToLowerInvariant()
            if ($recorded -eq $hash) { Good "matches the .sha256 beside it" }
            else {
                Fail "does NOT match the .sha256 beside it"
                $problems += "the MSI and its checksum file disagree"
            }
        }

        try {
            $sig = Get-AuthenticodeSignature -LiteralPath $msiItem.FullName
            if ($sig.Status -eq "Valid") { Good "signed: $($sig.SignerCertificate.Subject.Split(',')[0])" }
            else { Warn "not signed - SmartScreen will warn every customer who runs it" }
        } catch {
            Warn "the signature could not be read: $($_.Exception.Message)"
        }

        # A bundled MSI is the payload plus the runtimes. One that came out
        # small is one that staged without them.
        if ($msiItem.Length -lt 60MB) {
            Warn "this MSI is small for a bundled build - check that vendor\ was staged into it"
        }
    }
}

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
Write-Host ""
foreach ($note in $notes) { Write-Host "  $note" -ForegroundColor DarkGray }
Write-Host ""

if ($problems.Count -eq 0) {
    Write-Host "  This bundle installs on a machine with nothing on it and no network." -ForegroundColor Green
    Write-Host "  The one thing this cannot prove is Windows itself: run the MSI once on a" -ForegroundColor DarkGray
    Write-Host "  clean machine with the network unplugged before shipping it to anybody." -ForegroundColor DarkGray
    Write-Host ""
    exit 0
}

Write-Host "  Not ready to ship:" -ForegroundColor Red
foreach ($p in $problems) { Write-Host "    * $p" -ForegroundColor Red }
Write-Host ""
exit 1
