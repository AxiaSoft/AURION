<#
.SYNOPSIS
    Install AURION's Python libraries - fastapi, numpy, scikit-learn and the
    rest of engine\requirements.txt - into the interpreter AURION actually
    runs on.

.DESCRIPTION
    This is the "by hand" repair, and it used to be a trap. It ran
    `python -m pip ...` and left the rest to PATH, which on a machine with
    AURION's own interpreter is wrong in three ways at once:

      * AURION's Python is installed inside AURION's folder and is on
        nobody's PATH, so `python` was either not found or a different
        interpreter - one whose NumPy the engine never loads.
      * On a machine with no Python at all, `python` resolves to
        %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe, which is not an
        interpreter but an app execution alias: it opens the Store, or writes
        packages somewhere site-packages will never look.
      * `$ErrorActionPreference = "Stop"` plus a native program that writes
        to stderr is a terminating error in Windows PowerShell 5.1, so the
        first pip that complained ended the script with nothing said.

    So it now finds the interpreter the same way start-aurion.cmd and
    provision.ps1 do - AURION's own first, then runtime.env, then the
    registry, then the launcher - asks it to install engine\requirements.txt,
    and verifies the result by importing it. If pip is missing it is set up
    first. If the wheels the build bundled are there, it uses them and never
    touches the network.

.PARAMETER InstallFolder
    The AURION installation. Defaults to the folder containing this script.

.PARAMETER Offline
    Use only wheels from disk. Fails, saying so, when there are none.

.PARAMETER Wheels
    A folder of .whl files to install from. Defaults to the installation's
    own vendor\wheels, which is where a build carries them. For a machine
    with no route to PyPI: download them elsewhere, copy the folder over,
    and run this with -Wheels pointing at it.

.PARAMETER IndexUrl
    A package index this machine can reach, when pypi.org is filtered. Also
    read from AURION_PIP_INDEX_URL.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File C:\...\AURION\scripts\fix-numpy.ps1
#>

[CmdletBinding()]
param(
    [string] $InstallFolder = "",
    [switch] $Offline,
    [string] $Wheels = "",
    [string] $IndexUrl = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# Reads of $LASTEXITCODE before the first native command would otherwise be an
# error under StrictMode.
$global:LASTEXITCODE = 0

try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

function Say  { param([string] $T) Write-Host "  $T" }
function Head { param([string] $T) Write-Host ""; Write-Host $T -ForegroundColor Cyan }
function Bad  { param([string] $T) Write-Host "  $T" -ForegroundColor Yellow }

# ---------------------------------------------------------------------------
# Where AURION is
# ---------------------------------------------------------------------------
if (-not $InstallFolder -and $PSScriptRoot) {
    $beside = Split-Path -Parent $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $beside "engine\requirements.txt")) { $InstallFolder = $beside }
}

if (-not $InstallFolder) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\AURION"),
        (Join-Path ${env:ProgramFiles} "AURION"),
        (Join-Path ${env:ProgramFiles(x86)} "AURION")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
    $InstallFolder = $candidates | Select-Object -First 1
}

if (-not $InstallFolder -or -not (Test-Path -LiteralPath $InstallFolder)) {
    throw "Could not find an installed AURION. Pass -InstallFolder ""C:\path\to\AURION""."
}
$InstallFolder = (Resolve-Path -LiteralPath $InstallFolder).Path.TrimEnd('\')

Write-Host ""
Write-Host "  AURION: installing the engine's Python libraries" -ForegroundColor White
Write-Host "  ----------------------------------------------" -ForegroundColor White
Say "installation: $InstallFolder"

$logDir = Join-Path $InstallFolder "data\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir "setup.log"

function Log {
    param([string] $Text)
    try { Add-Content -LiteralPath $logFile -Value ("{0:u}  fix-numpy: {1}" -f (Get-Date), $Text) } catch { }
}

# ---------------------------------------------------------------------------
# Running things
# ---------------------------------------------------------------------------
# The same two faults that stopped provision.ps1 from installing these
# libraries live here too: an argv array sliced with [1..(Length-1)] (which
# for AURION's one-element interpreter is the descending range 1..0), and a
# native program writing to stderr becoming a terminating error. Every child
# process below is started with the error preference turned down, so the exit
# code is the answer and never an exception.
function Invoke-Program {
    param([string] $Program, [string[]] $Arguments, [string] $WorkingDirectory = "")

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $said = @()
    $pushed = $false
    try {
        if ($WorkingDirectory) { Push-Location -LiteralPath $WorkingDirectory; $pushed = $true }
        $argv = @($Arguments | Where-Object { $null -ne $_ })
        & $Program @argv 2>&1 | ForEach-Object {
            $line = ("$_" -replace "`r", "").TrimEnd()
            if ($line.Length -eq 0) { return }
            $said += $line
            Write-Host "    $line"
        }
    } catch {
        $said += "$_"
        Bad "$_"
    } finally {
        if ($pushed) { Pop-Location }
        $ErrorActionPreference = $previous
    }

    return [pscustomobject]@{
        ExitCode = [int]$LASTEXITCODE
        Text     = (@($said) -join [Environment]::NewLine)
    }
}

function Invoke-Python {
    param([string[]] $Python, [string[]] $Arguments)

    $argv = @()
    if ($Python.Count -gt 1) { $argv += $Python[1..($Python.Count - 1)] }
    if ($Arguments) { $argv += $Arguments }
    return (Invoke-Program -Program $Python[0] -Arguments $argv)
}

function Find-Python {
    $mine = Join-Path $InstallFolder "runtime\python\python.exe"
    if (Test-Path -LiteralPath $mine) { return @($mine) }

    # What setup recorded last time, unless it is the Store alias.
    $runtimeEnv = Join-Path $InstallFolder "data\runtime.env"
    if (Test-Path -LiteralPath $runtimeEnv) {
        foreach ($line in Get-Content -LiteralPath $runtimeEnv) {
            if ($line -match '^\s*PYTHON\s*=\s*(.+)$') {
                $recorded = $Matches[1].Trim()
                if ((Test-Path -LiteralPath $recorded) -and ($recorded -notlike "*\WindowsApps\*")) {
                    return @($recorded)
                }
            }
        }
    }

    foreach ($v in @("3.12", "3.11", "3.10")) {
        foreach ($hive in @("HKCU:", "HKLM:")) {
            try {
                $key = "$hive\Software\Python\PythonCore\$v\InstallPath"
                $dir = (Get-ItemProperty -Path $key -ErrorAction Stop)."(default)"
                if (-not $dir) { continue }
                $exe = Join-Path $dir "python.exe"
                if (Test-Path -LiteralPath $exe) { return @($exe) }
            } catch { }
        }
    }
    return $null
}

function Get-PythonVersion {
    param([string[]] $Python)
    $probe = Invoke-Python -Python $Python -Arguments @("-V")
    $m = [regex]::Match($probe.Text, "Python\s+\d+\.\d+\.\d+")
    return ($(if ($m.Success) { $m.Value } else { "" }))
}

# ---------------------------------------------------------------------------
# 1. Which interpreter
# ---------------------------------------------------------------------------
Head "Interpreter"
$python = Find-Python
if (-not $python) {
    Bad "no Python was found in $InstallFolder"
    Say "AURION installs its own. Run setup, which does exactly that:"
    Say "    powershell -ExecutionPolicy Bypass -File ""$InstallFolder\scripts\provision.ps1"""
    exit 1
}
Say ($python -join ' ')
$version = Get-PythonVersion -Python $python
if ($version.Length -gt 0) { Say $version }

if ($version -match "Python\s+3\.(1[3-9]|[2-9]\d)") {
    Bad "$version is newer than the engine supports."
    Say "The engine is pinned to NumPy 1.26.4, which has no wheel for CPython 3.13"
    Say "or newer. AURION's own Python is 3.12 and lives inside the installation."
    Say "Reinstall AURION, or run scripts\provision.ps1, which puts one there."
    exit 1
}

# ---------------------------------------------------------------------------
# 2. pip
# ---------------------------------------------------------------------------
Head "pip"
$hasPip = $false
$probe = Invoke-Python -Python $python -Arguments @("-m", "pip", "--version")
if ($probe.ExitCode -eq 0) {
    Say $probe.Text.Trim()
    $hasPip = $true
}

if (-not $hasPip) {
    Say "pip is missing - setting it up"
    $null = Invoke-Python -Python $python -Arguments @("-m", "ensurepip", "--upgrade", "--default-pip")
    $probe = Invoke-Python -Python $python -Arguments @("-m", "pip", "--version")
    if ($probe.ExitCode -eq 0) {
        Say $probe.Text.Trim()
        $hasPip = $true
    }
}

if (-not $hasPip) {
    $getPip = Join-Path $InstallFolder "vendor\get-pip.py"
    if (-not (Test-Path -LiteralPath $getPip)) {
        $getPip = Join-Path $env:TEMP "get-pip.py"
        Say "downloading get-pip.py from bootstrap.pypa.io"
        Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip -UseBasicParsing
    }
    $null = Invoke-Python -Python $python -Arguments @($getPip, "--no-warn-script-location", "--no-input")
    $probe = Invoke-Python -Python $python -Arguments @("-m", "pip", "--version")
    if ($probe.ExitCode -eq 0) {
        Say $probe.Text.Trim()
        $hasPip = $true
    }
}

if (-not $hasPip) {
    Bad "pip could not be set up in $($python[0])"
    Log "pip could not be set up: $($probe.Text)"
    exit 1
}

# ---------------------------------------------------------------------------
# 3. The libraries
# ---------------------------------------------------------------------------
Head "engine\requirements.txt"

$requirements = Join-Path $InstallFolder "engine\requirements.txt"
if (-not (Test-Path -LiteralPath $requirements)) {
    throw "$requirements is missing. Repair the installation, then run this again."
}

$wheels = Join-Path $InstallFolder "vendor\wheels"
if ($Wheels) {
    if (-not (Test-Path -LiteralPath $Wheels)) { throw "There is no folder at -Wheels $Wheels." }
    $wheels = (Resolve-Path -LiteralPath $Wheels).Path
}
$bundled = $false
if (Test-Path -LiteralPath $wheels) {
    if (@(Get-ChildItem -LiteralPath $wheels -Filter *.whl -ErrorAction SilentlyContinue).Count -gt 0) {
        $bundled = $true
    }
}

if (-not $IndexUrl -and $env:AURION_PIP_INDEX_URL) { $IndexUrl = $env:AURION_PIP_INDEX_URL }

$arguments = @("-m", "pip", "install")
if ($Offline -or $bundled) {
    if (-not $bundled) {
        Bad "there are no wheels in $wheels, so -Offline cannot be honoured"
        exit 1
    }
    Say "installing from the wheels in $wheels - no download"
    $arguments += @("--no-index", "--find-links", $wheels)
} else {
    # The old script removed NumPy 2 and installed a list of pins by hand.
    # requirements.txt is that list, and it is the one the engine reads, so
    # the two can no longer disagree.
    Say "this is the long one - NumPy and scikit-learn are around 90 MB"
    $arguments += @("--no-cache-dir", "--retries", "3", "--timeout", "60")
    if ($IndexUrl) {
        Say "using the package index $IndexUrl"
        $arguments += @("--index-url", $IndexUrl)
    }
    # NumPy 2 needs CPU flags that some machines do not have, so a pinned
    # 1.26.4 is reinstalled rather than left as whatever is there. Removing
    # it first is what makes that possible.
    Say "removing any NumPy 2.x first, so the pinned 1.26.4 can replace it"
    $null = Invoke-Python -Python $python -Arguments @("-m", "pip", "uninstall", "-y", "numpy")
}

$arguments += @("-r", $requirements, "--no-input", "--disable-pip-version-check")
$run = Invoke-Python -Python $python -Arguments $arguments
Log ("pip exit code " + $run.ExitCode)
Log $run.Text

if ($run.ExitCode -ne 0) {
    Bad "pip finished with code $($run.ExitCode)"
    if ($run.Text -match "CERTIFICATE_VERIFY_FAILED|certificate verify failed|SSL") {
        Say "The connection to the package index was refused. On a filtered network,"
        Say "use a mirror this machine can reach:"
        Say "    powershell -ExecutionPolicy Bypass -File scripts\fix-numpy.ps1 -IndexUrl https://<mirror>/simple"
    }
    if ($run.Text -match "ConnectTimeout|ReadTimeout|NewConnectionError|getaddrinfo|Temporary failure in name resolution") {
        Say "The package index could not be reached at all. Two ways out:"
        Say "  * a proxy that works, in the environment pip already reads:"
        Say "        set HTTPS_PROXY=http://user:pass@host:port"
        Say "  * or no network at all - copy the wheels from a build machine into"
        Say "    $wheels, then:"
        Say "        powershell -ExecutionPolicy Bypass -File scripts\fix-numpy.ps1 -Offline"
    }
    Say "What pip said is in $logFile"
    exit 1
}

# ---------------------------------------------------------------------------
# 4. Prove it
# ---------------------------------------------------------------------------
Head "Checking"
$check = Invoke-Python -Python $python -Arguments @(
    "-c", "import fastapi, numpy, sklearn, pandas, scipy, uvicorn; print('numpy', numpy.__version__)")
if ($check.ExitCode -ne 0) {
    Bad "the libraries were installed but do not import"
    Log $check.Text
    Say "and that is what the engine would have hit. The reason:"
    foreach ($line in ($check.Text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 6)) {
        Say "    $line"
    }
    Say "If it mentions X86_V2, this CPU cannot run the NumPy wheel that is"
    Say "installed - run setup, which installs the pinned 1.26.4 for that reason."
    exit 1
}

Say $check.Text.Trim()
Write-Host ""
Write-Host "  AURION's engine libraries are installed." -ForegroundColor Green
Write-Host "  Start the desk again with start-aurion.cmd, or AURION from the Start menu."
Write-Host ""
exit 0
