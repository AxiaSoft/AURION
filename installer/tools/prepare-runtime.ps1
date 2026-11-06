<#
.SYNOPSIS
    Builds the Python that AURION ships, with the engine's libraries already
    inside it.

.DESCRIPTION
    fetch-vendor.ps1 collects the raw pieces: the embeddable Python, get-pip.py
    and the engine's wheels. That is enough to install AURION on a machine with
    no network, but it leaves the expensive half of the job - pip resolving and
    unpacking ninety megabytes of NumPy, SciPy, pandas and scikit-learn - to
    the setup window on the trader's machine.

    This does it here instead, once, on the build machine. The result is one
    file:

        installer\vendor\runtime-python.zip
            python.exe, python312.dll, python312.zip (the standard library)
            Lib\site-packages\   fastapi, numpy 1.26.4, scipy, scikit-learn,
                                 pandas, uvicorn, MetaTrader5, ...
            vcruntime140.dll, vcruntime140_1.dll, msvcp140.dll
            python312._pth       already patched to enable site-packages

    Unzipping it into runtime\python is the whole install: no pip run, no
    index, no compiler, no wheel to build, nothing that can decide to reach
    the network. The setup window and scripts\provision.ps1 both prefer it and
    fall back to the old pieces when a build does not have it.

    Everything is verified before it is packaged. The finished tree is run with
    -I (isolated: no PYTHONPATH, no PYTHONHOME, no user site-packages) and the
    engine's libraries are imported from it. A runtime that cannot import what
    the engine needs fails the build here, on a machine with a developer, and
    never on the customer's.

.PARAMETER Vendor
    The folder fetch-vendor.ps1 filled in. Defaults to installer\vendor.

.PARAMETER Root
    The repository root. Defaults to two levels above this script.

.PARAMETER Force
    Rebuild even when runtime-python.zip is newer than everything that went
    into it.

.PARAMETER KeepTests
    Keep the test suites that some wheels ship inside their packages. They are
    dropped by default: they more than double the size of the runtime, contain
    the longest paths in it, and nothing imports them.

.PARAMETER VcRuntimeDir
    Where to take the Visual C++ runtime DLLs from, when they are not in
    C:\Windows\System32. Any folder that has them will do.

.PARAMETER SkipVcRuntime
    Package the runtime even if msvcp140.dll could not be found. The engine's
    C++ wheel builds (pandas, scikit-learn) need it; a machine that has never
    had a C++ program installed may not provide it. Only for a diagnostic
    build - a release build should not use this.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\prepare-runtime.ps1
#>
[CmdletBinding()]
param(
    [string] $Vendor = "",
    [string] $Root   = "",
    [string] $PythonZipName = "python-3.12.7-embed-amd64.zip",
    [string] $GetPipName    = "get-pip.py",
    [string] $OutputName    = "runtime-python.zip",
    [string] $VcRuntimeDir  = "",
    [switch] $Force,
    [switch] $KeepTests,
    [switch] $SkipVcRuntime
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Say([string] $msg) { Write-Host "  $msg" }
function Head([string] $msg) { Write-Host ""; Write-Host $msg -ForegroundColor Cyan }

$installerDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Vendor) { $Vendor = Join-Path $installerDir "vendor" }
if (-not $Root)   { $Root   = (Resolve-Path (Join-Path $installerDir "..")).Path }

$vendorDir = $Vendor
$requirements = Join-Path $Root "engine\requirements.txt"
$wheelDir = Join-Path $vendorDir "wheels"
$embedZip = Join-Path $vendorDir $PythonZipName
$getPip   = Join-Path $vendorDir $GetPipName
$output   = Join-Path $vendorDir $OutputName
$work     = Join-Path $vendorDir ".runtime-build"
$python   = Join-Path $work "python"

Add-Type -AssemblyName System.IO.Compression.FileSystem

# ---------------------------------------------------------------------------
# 1. What we need, and a clear account of anything missing.
# ---------------------------------------------------------------------------
Head "Python runtime for the engine, libraries included"
Say "vendor $vendorDir"

$missing = @()
foreach ($need in @(
    @{ Path = $embedZip;     What = "$PythonZipName - run fetch-vendor.ps1" },
    @{ Path = $getPip;       What = "$GetPipName - run fetch-vendor.ps1" },
    @{ Path = $requirements; What = "engine\requirements.txt" })) {
    if (-not (Test-Path -LiteralPath $need.Path)) { $missing += $need.What }
}
$wheels = @()
if (Test-Path -LiteralPath $wheelDir) {
    $wheels = @(Get-ChildItem -LiteralPath $wheelDir -Filter *.whl -File)
}
if ($wheels.Count -eq 0) { $missing += "wheels\*.whl - run fetch-vendor.ps1 with a Python on this machine" }

if ($missing.Count -gt 0) {
    throw ("The Python runtime cannot be built from what is in $vendorDir.`n" +
           (($missing | ForEach-Object { "  missing: $_" }) -join [Environment]::NewLine) + "`n" +
           "  Every one of those comes from: installer\tools\fetch-vendor.ps1`n" +
           "  Without them the installer falls back to installing the libraries on the`n" +
           "  customer's machine, which is what this build is meant to remove.")
}

# ---------------------------------------------------------------------------
# 2. Reuse, when nothing that goes into it has changed.
# ---------------------------------------------------------------------------
# Ticks rather than DateTime: Measure-Object's -Maximum is happy with numbers
# everywhere, and this has to work on Windows PowerShell 5.1 as well as 7.
$inputs = @($embedZip, $getPip, $requirements, $PSCommandPath) +
          @($wheels | ForEach-Object { $_.FullName })
$newest = ($inputs |
           ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTimeUtc.Ticks } |
           Measure-Object -Maximum).Maximum
if ((Test-Path -LiteralPath $output) -and -not $Force) {
    $built = (Get-Item -LiteralPath $output).LastWriteTimeUtc.Ticks
    if ($built -ge $newest) {
        Say ("{0} is up to date, {1:N1} MB" -f $OutputName, ((Get-Item -LiteralPath $output).Length / 1MB))
        Say "nothing to do (-Force rebuilds it)"
        return
    }
}

# ---------------------------------------------------------------------------
# 3. Unpack the interpreter.
# ---------------------------------------------------------------------------
Head "Unpacking $PythonZipName"
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Path $python -Force | Out-Null
[System.IO.Compression.ZipFile]::ExtractToDirectory($embedZip, $python)

$exe = Join-Path $python "python.exe"
if (-not (Test-Path -LiteralPath $exe)) {
    throw "$PythonZipName does not contain python.exe at its root, so it is not the embeddable build."
}

# The embeddable build ships with site-packages switched off. Left as it is,
# pip installs into a folder the interpreter never looks in and every import
# the engine needs fails with the libraries sitting right there. provision.ps1
# and Prerequisites.cs both patch this too; doing it here is what lets the
# finished zip be unzipped and used without any further step.
$pth = Join-Path $python "python312._pth"
if (-not (Test-Path -LiteralPath $pth)) {
    $found = @(Get-ChildItem -LiteralPath $python -Filter "python*._pth" -File)
    if ($found.Count -gt 0) { $pth = $found[0].FullName }
}
if (Test-Path -LiteralPath $pth) {
    $lines = @(Get-Content -LiteralPath $pth |
               ForEach-Object { if ($_.Trim() -eq "#import site") { "import site" } else { $_ } })
    if ($lines -notcontains "import site") { $lines += "import site" }
    if ($lines -notcontains "Lib\site-packages") { $lines += "Lib\site-packages" }
    Set-Content -LiteralPath $pth -Value $lines
    Say "patched $(Split-Path -Leaf $pth): site-packages enabled"
} else {
    throw "No ._pth file in $PythonZipName, so site-packages cannot be enabled."
}
New-Item -ItemType Directory -Path (Join-Path $python "Lib\site-packages") -Force | Out-Null

# Native calls below write progress to stderr and are not errors.
function Invoke-Python {
    param([string] $What, [string[]] $Arguments)
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $text = & $exe @Arguments 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    if ($code -ne 0) {
        $tail = ($text.Trim() -split "`r?`n" | Select-Object -Last 25) -join [Environment]::NewLine
        throw ("$What failed with exit code $code.`n" + $tail)
    }
    return $text
}

$version = (Invoke-Python -What "Checking the interpreter" -Arguments @("-V")).Trim()
Say "interpreter: $version"

# ---------------------------------------------------------------------------
# 4. pip. Carried inside get-pip.py, so this needs no network either.
# ---------------------------------------------------------------------------
Head "Installing pip into it"
# --no-setuptools / --no-wheel keep get-pip from going to PyPI for the two
# packages it only installs by default; nothing here builds a source
# distribution, so neither is needed.
Say "get-pip.py (its own copy of pip, no network)"
# --no-setuptools / --no-wheel keep get-pip from fetching the two packages it
# only installs by default. They are get-pip's own options and have been for
# years, but a bootstrap script is not something we pin - if a future one
# stops recognising them, the flags are dropped rather than the build.
try {
    $null = Invoke-Python -What "get-pip.py" -Arguments @(
        $getPip, "--no-warn-script-location", "--no-input", "--disable-pip-version-check",
        "--no-setuptools", "--no-wheel")
} catch {
    Say "get-pip.py did not accept the offline flags; trying again without them"
    Say ($_.Exception.Message -split "`r?`n" | Select-Object -First 3 | Out-String).Trim()
    $null = Invoke-Python -What "get-pip.py" -Arguments @(
        $getPip, "--no-warn-script-location", "--no-input", "--disable-pip-version-check")
}

# ---------------------------------------------------------------------------
# 5. The engine's libraries, from the bundled wheels only.
# ---------------------------------------------------------------------------
Head "Installing the engine's libraries from vendor\wheels"
Say ("{0} wheels, {1:N1} MB" -f $wheels.Count, ((($wheels | Measure-Object Length -Sum).Sum) / 1MB))
# --no-index is the point: not "prefer the wheels", but "only the wheels". A
# build that silently reached PyPI here would produce a zip nobody can audit,
# and would hide a wheel that fetch-vendor.ps1 failed to collect.
Say "this is the slow one: pip unpacking the engine's libraries into the runtime"
$null = Invoke-Python -What "pip install -r engine\requirements.txt" -Arguments @(
    "-m", "pip", "install", "-r", $requirements,
    "--no-index", "--find-links", $wheelDir,
    "--no-cache-dir", "--no-warn-script-location", "--disable-pip-version-check")

# MetaTrader5 is Windows-only and deliberately marked optional in
# requirements.txt, so it is bundled by name rather than by the requirement
# file. Without it the desk installs fine and then cannot talk to the
# terminal - and the old code fetched it from PyPI on the customer's machine
# at first run, which is the thing this build exists to stop.
$mt5 = @($wheels | Where-Object { $_.Name -like "MetaTrader5-*" })
if ($mt5.Count -gt 0) {
    Say "MetaTrader5 ($($mt5[0].Name))"
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = & $exe -m pip install "MetaTrader5" --no-index --find-links $wheelDir `
            --no-cache-dir --no-warn-script-location --disable-pip-version-check 2>&1 | Out-String
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    if ($code -ne 0) {
        # Not fatal: the engine imports it optionally and says so. But it is
        # the one library a trader is most likely to miss, so it is loud.
        Write-Host "  MetaTrader5 could not be installed into the runtime - the desk will" -ForegroundColor Yellow
        Write-Host "  start, but it cannot reach the terminal until it is repaired:" -ForegroundColor Yellow
        Write-Host (($out.Trim() -split "`r?`n" | Select-Object -Last 5) -join [Environment]::NewLine) -ForegroundColor Yellow
    } else {
        Say "MetaTrader5 installed"
    }
} else {
    Write-Host "  no MetaTrader5 wheel in vendor\wheels - the desk will not reach the terminal" -ForegroundColor Yellow
    Write-Host "  until it is installed; fetch-vendor.ps1 collects it when it can." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 6. The Visual C++ runtime, next to python.exe.
# ---------------------------------------------------------------------------
# The wheels' compiled modules import vcruntime140.dll, vcruntime140_1.dll and
# msvcp140.dll. The embeddable Python carries the first; the other two come
# with the VC++ redistributable, which a machine that has never run a C++
# program may not have. Shipping them next to python.exe is what makes "no
# prerequisite downloads" true rather than nearly true: a DLL that sits in the
# same folder as the .exe that needs it wins without being registered
# anywhere.
Head "Visual C++ runtime"
$dllNames = @("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll",
              "msvcp140_1.dll", "msvcp140_2.dll", "concrt140.dll")
$sources = @()
if ($VcRuntimeDir) { $sources += $VcRuntimeDir }
if ($env:SystemRoot) {
    $system32 = Join-Path $env:SystemRoot "System32"
    # A 32-bit PowerShell is shown SysWOW64 as "System32", which would put
    # 32-bit DLLs next to a 64-bit python.exe and fail every import with a
    # message about the wrong machine type. Sysnative is the real folder.
    if (-not [Environment]::Is64BitProcess) {
        $native = Join-Path $env:SystemRoot "Sysnative"
        if (Test-Path -LiteralPath $native) { $system32 = $native }
    }
    $sources += $system32
}
$copied = @()
foreach ($dll in $dllNames) {
    $dst = Join-Path $python $dll
    if (Test-Path -LiteralPath $dst) { $copied += "$dll (from the embeddable build)"; continue }
    foreach ($dir in $sources) {
        $src = Join-Path $dir $dll
        if (Test-Path -LiteralPath $src) {
            Copy-Item -LiteralPath $src -Destination $dst -Force
            $copied += $dll
            break
        }
    }
}
foreach ($c in $copied) { Say $c }
foreach ($required in @("vcruntime140.dll", "msvcp140.dll")) {
    if (-not (Test-Path -LiteralPath (Join-Path $python $required))) {
        if ($SkipVcRuntime) {
            Write-Host "  $required is not on this machine and -SkipVcRuntime was given." -ForegroundColor Yellow
            Write-Host "  pandas and scikit-learn will not import on a machine that lacks it." -ForegroundColor Yellow
        } else {
            throw ("$required could not be found, and the engine's compiled libraries need it.`n" +
                   "  Install the Microsoft Visual C++ 2015-2022 Redistributable (x64) on this`n" +
                   "  build machine - it puts the DLLs in C:\Windows\System32 - or point`n" +
                   "  -VcRuntimeDir at a folder that has them.`n" +
                   "  (-SkipVcRuntime packages the runtime anyway, for a diagnostic build.)")
        }
    }
}

# ---------------------------------------------------------------------------
# 7. Trim what nothing imports.
# ---------------------------------------------------------------------------
$site = Join-Path $python "Lib\site-packages"
$pyc = @(Get-ChildItem -LiteralPath $python -Recurse -File -Include "*.pyc", "*.pyo" -ErrorAction SilentlyContinue)
foreach ($f in $pyc) { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction SilentlyContinue }
$cacheDirs = @(Get-ChildItem -LiteralPath $python -Recurse -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue)
foreach ($d in $cacheDirs) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
Say ("dropped {0} bytecode files and {1} __pycache__ folders" -f $pyc.Count, $cacheDirs.Count)

if (-not $KeepTests) {
    # Several wheels ship their own test suite. pandas' alone is bigger than
    # the rest of the library, and the longest paths in the runtime are inside
    # them - the sort of thing that turns into a "path too long" during
    # extraction on a machine with a long user name. Nothing imports them.
    $testDirs = @(Get-ChildItem -LiteralPath $site -Recurse -Directory -ErrorAction SilentlyContinue |
                  Where-Object { $_.Name -in @("tests", "test") })
    # Only ones inside a package: a top-level "tests" folder is not something
    # pip installs, and deleting it would be guesswork.
    $testDirs = @($testDirs | Where-Object { $_.FullName.StartsWith($site) -and
                    (Split-Path $_.FullName -Parent) -ne $site })
    foreach ($d in $testDirs) { Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    Say ("dropped {0} test folders" -f $testDirs.Count)
}

# ---------------------------------------------------------------------------
# 8. Prove it works before it is packaged.
# ---------------------------------------------------------------------------
# This is the part that makes the rest worth doing. -I isolates the run from
# this machine: no PYTHONPATH, no PYTHONHOME, no user site-packages. If an
# import below succeeds, it succeeded on what is in the zip and nothing else.
Head "Verifying the runtime in isolation"
$imports = "import sys, fastapi, uvicorn, numpy, pandas, scipy, sklearn, pydantic, websockets, httpx, openpyxl, tzdata; print('ok', sys.version.split()[0], numpy.__version__, pandas.__version__, sklearn.__version__)"
$previousEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $report = & $exe -I -c $imports 2>&1 | Out-String
    $code = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousEap
}
if ($code -ne 0) {
    throw ("The packaged Python cannot import the engine's libraries:`n" +
           (($report.Trim() -split "`r?`n" | Select-Object -Last 25) -join [Environment]::NewLine) + "`n" +
           "  A runtime that fails here would fail on the customer's machine, so the build stops.")
}
Say $report.Trim()

# MetaTrader5 imports its own compiled module; a machine without the terminal
# still imports it, so this only proves the wheel landed intact.
try {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $mt5Out = & $exe -I -c "import MetaTrader5; print('MetaTrader5 imports')" 2>&1 | Out-String
        $mt5Code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousEap
    }
    if ($mt5Code -eq 0) { Say $mt5Out.Trim() }
    else { Write-Host "  MetaTrader5 does not import here; the desk will run without the terminal" -ForegroundColor Yellow }
} catch { }

# pip's own dependency audit. Not fatal - a wheel that needs something newer
# than the pin would already have failed the import above - but it is the one
# place a half-satisfied requirement shows up by name.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $audit = (& $exe -I -m pip check 2>&1 | Out-String).Trim()
} finally {
    $ErrorActionPreference = $previousEap
}
if ($audit -and $audit -notmatch "No broken requirements found") {
    Write-Host "  pip check:" -ForegroundColor Yellow
    Write-Host $audit -ForegroundColor Yellow
}

$pipOut = $null
$previousEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    $pipOut = (& $exe -I -m pip --version 2>&1 | Out-String).Trim()
    $pipCode = $LASTEXITCODE
} finally {
    $ErrorActionPreference = $previousEap
}
if ($pipCode -ne 0) { throw "The packaged Python has no working pip, so it cannot be repaired offline: $pipOut" }
Say $pipOut

# ---------------------------------------------------------------------------
# 9. Package it.
# ---------------------------------------------------------------------------
Head "Packaging $OutputName"
# .part, so an interrupted build cannot leave a half-written zip that the
# next one would happily ship. Built by concatenation, not "$output.part":
# inside a double-quoted string that is a member access, and a string has no
# .part.
$part = $output + ".part"
if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }

$files = @(Get-ChildItem -LiteralPath $python -Recurse -File)
$rawMb = (($files | Measure-Object Length -Sum).Sum / 1MB)
Say ("{0} files, {1:N1} MB uncompressed" -f $files.Count, $rawMb)

# includeBaseDirectory = $false: python.exe has to be at the root of the zip,
# because the installer unzips it straight into runtime\python.
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $python, $part, [System.IO.Compression.CompressionLevel]::Optimal, $false)
Move-Item -LiteralPath $part -Destination $output -Force

$zipBytes = (Get-Item -LiteralPath $output).Length
Say ("{0}, {1:N1} MB" -f $OutputName, ($zipBytes / 1MB))

Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host ("  runtime ready: {0} ({1:N1} MB, {2:N1} MB unpacked)" -f
            $output, ($zipBytes / 1MB), $rawMb) -ForegroundColor Green
Write-Host "  the installer unpacks this; it runs no pip on the target machine" -ForegroundColor Green
Write-Host ""
