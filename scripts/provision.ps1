<#
.SYNOPSIS
    Install everything AURION runs on, without asking and without an
    administrator.

.DESCRIPTION
    A clean Windows machine has neither Python nor Node. AURION's window
    already knows how to fetch both, but that knowledge lives inside
    AURION.exe - which means a machine can only be repaired by shipping a new
    binary to it, and until that binary arrives the desk does not start.

    This is the same work as a plain script, so it can be delivered by
    update-installed-desk.ps1 and run by start-aurion.cmd on a machine that
    already has AURION installed. Nothing here needs elevation:

      * Python goes in per-user, the way python.org's installer supports.
      * Node is the official zip, unpacked into the installation's own
        runtime\node. No MSI, no UAC prompt, nothing machine-wide, and it
        disappears when AURION is uninstalled.

    Two rules are kept, because a script that downloads and runs things has
    no business being casual about either:

      1. Nothing unverified is executed. The Python installer must carry an
         Authenticode signature from the Python Software Foundation. The Node
         zip has no signature to check, so it is matched against the SHA-256
         that nodejs.org publishes beside it.
      2. Nothing already present is reinstalled. Everything is detected
         first, and a prepared machine leaves in a couple of seconds.

    Safe to run twice. Safe to run on a machine that is already working.

.PARAMETER InstallFolder
    The AURION installation. Defaults to the folder containing this script's
    parent - i.e. the installation this copy of the script was shipped in.

.PARAMETER SkipPython
    Leave Python alone. For a machine where it is managed centrally.

.PARAMETER SkipNode
    Leave Node alone.

.PARAMETER Start
    Launch AURION when it finishes, so one command ends with a running desk.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\provision.ps1

.EXAMPLE
    # On a machine where AURION is installed but this script is not there yet.
    # Finds the installation by itself and starts the desk when it is done.
    iwr -UseBasicParsing <raw url>/scripts/provision.ps1 -OutFile $env:TEMP\p.ps1
    & $env:TEMP\p.ps1 -Start
#>

[CmdletBinding()]
param(
    [string] $InstallFolder = "",
    [switch] $SkipPython,
    [switch] $SkipNode,
    [switch] $Start
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# $LASTEXITCODE does not exist until the first native command has run, and
# StrictMode -Version Latest treats a read of a variable that does not exist
# as an error. One assignment here makes every later reference safe - there
# are several, all of them just after running Python - without wrapping each
# one in a try.
$global:LASTEXITCODE = 0

# TLS 1.2 is not the default on an un-updated Windows PowerShell 5.1, and
# both python.org and nodejs.org refuse anything older.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

<#
    Every way out of this script leaves a line behind, and a non-zero code.

    This runs with $ErrorActionPreference = "Stop", and when start-aurion.cmd
    starts it - which is how it runs on a machine that cannot start - it runs
    in a console that is created hidden and never read. A terminating error
    therefore used to leave: no line in setup.log after whatever happened to
    be said last, no exit code anyone looked at, and a desk window reporting
    that "neither the engine nor the desk wrote anything this time". The
    error itself went to a stderr stream belonging to a hidden process and
    was discarded.

    A machine with AURION's own Python and none of its libraries did exactly
    that: setup said "Python is already here", died on the very next line -
    the check that decides whether to install the libraries - and installed
    nothing. Twice, because the launcher retries.

    The trap is now the last word on any unexpected stop: the reason goes
    into the log the window already quotes, and the exit code says so.
#>
trap {
    $reason = "$($_.Exception.Message)"
    $where  = "$($_.InvocationInfo.PositionMessage)"

    Write-Host ""
    Write-Host "Setup stopped: $reason" -ForegroundColor Yellow

    # Which log, without assuming how far the script got before it died.
    $log = $null
    $known = Get-Variable -Name logFile -ErrorAction SilentlyContinue
    if ($known -and $known.Value) {
        $log = $known.Value
    } else {
        $folder = Get-Variable -Name InstallFolder -ErrorAction SilentlyContinue
        if ($folder -and $folder.Value) {
            $log = Join-Path $folder.Value "data\logs\setup.log"
        }
    }

    if ($log) {
        try {
            New-Item -ItemType Directory -Path (Split-Path -Parent $log) -Force | Out-Null
            Add-Content -LiteralPath $log -Value ("{0:u}  SETUP STOPPED: {1}" -f (Get-Date), $reason)
            if ($where) {
                $flat = (@($where -split "`r?`n") | Where-Object { $_.Trim().Length -gt 0 }) -join " | "
                Add-Content -LiteralPath $log -Value ("{0:u}  at {1}" -f (Get-Date), $flat.Trim())
            }
        } catch { }
    }
    exit 1
}

# ---------------------------------------------------------------------------
# Where the runtimes come from
# ---------------------------------------------------------------------------
# Official vendor URLs, https only. The Python version is pinned to one the
# engine supports: engine/requirements.txt pins numpy 1.26.4, which has no
# wheels for 3.13, and engine/main.py refuses to start on it.
$PythonVersion   = "3.12.7"
$PythonExeName   = "python-$PythonVersion-amd64.exe"
$PythonZipName   = "python-$PythonVersion-embed-amd64.zip"
$GetPipName      = "get-pip.py"
# Built by installer\tools\prepare-runtime.ps1: the same interpreter with the
# engine's libraries already installed into it. When a build carries it, this
# script unpacks one zip and is done - no installer, no pip run, no wheels.
$RuntimeZipName  = "runtime-python.zip"
$PythonUrl       = "https://www.python.org/ftp/python/$PythonVersion/$PythonExeName"
$PythonZipUrl    = "https://www.python.org/ftp/python/$PythonVersion/$PythonZipName"
$PythonPublisher = "Python Software Foundation"
# The PSF's own bootstrap, for a build that did not bundle get-pip.py. It
# carries pip inside it, so it needs nothing from PyPI to run.
$GetPipUrl       = "https://bootstrap.pypa.io/get-pip.py"
$NodeVersion     = "v20.17.0"
$NodeZipName     = "node-$NodeVersion-win-x64.zip"
$NodeZipUrl      = "https://nodejs.org/dist/$NodeVersion/$NodeZipName"
$NodeSumsUrl     = "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt"

# ---------------------------------------------------------------------------
# Saying what is happening
# ---------------------------------------------------------------------------
# Where AURION is.
#
# Normally this script sits in the installation's own scripts\ folder and the
# answer is one Split-Path away. But the single most useful way to run it is
# on a machine where AURION is installed and broken and this script is not
# there yet - downloaded straight from the repository and run from %TEMP%, in
# which case $PSScriptRoot points at %TEMP% and is worthless. So it falls
# back to looking the installation up the same way update-installed-desk.ps1
# does: the registry key the installer wrote, then the places it writes to.
if (-not $InstallFolder -and $PSScriptRoot) {
    $beside = Split-Path -Parent $PSScriptRoot
    if (Test-Path -LiteralPath (Join-Path $beside "apps\web\index.html")) { $InstallFolder = $beside }
}

if (-not $InstallFolder) {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\AURION"),
        (Join-Path ${env:ProgramFiles} "AURION"),
        (Join-Path ${env:ProgramFiles(x86)} "AURION")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

    # The installer records where it went; trust that over a guess.
    foreach ($key in @("HKCU:\Software\AURION", "HKLM:\Software\AURION")) {
        try {
            $v = (Get-ItemProperty -Path $key -ErrorAction Stop).InstallFolder
            if ($v -and (Test-Path -LiteralPath $v)) { $candidates = @($v) + $candidates }
        } catch { }
    }
    $InstallFolder = $candidates | Select-Object -First 1
}

if (-not $InstallFolder -or -not (Test-Path -LiteralPath $InstallFolder)) {
    throw "Could not find an installed AURION. Pass -InstallFolder ""C:\path\to\AURION""."
}
$InstallFolder = (Resolve-Path -LiteralPath $InstallFolder).Path.TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $InstallFolder "engine"))) {
    throw "$InstallFolder does not look like an AURION install (no engine folder)."
}

$logDir = Join-Path $InstallFolder "data\logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logFile = Join-Path $logDir "setup.log"

<#
    A runtime bundled inside the installation, or $null.

    installer\tools\fetch-vendor.ps1 puts Python, Node, WebView2 and the
    engine's wheels into the MSI, so a customer's machine installs AURION
    without reaching the network. That machine is the worst place to be
    discovering a proxy or a blocked domain: nobody can log into it, and the
    only symptom is a desk that does not start.
#>
function Get-Bundled {
    param([string] $Name)
    $p = Join-Path $InstallFolder "vendor\$Name"
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
}

function Say {
    param([string] $Text)
    $line = "{0:u}  {1}" -f (Get-Date), $Text
    Write-Host "  $Text"
    try { Add-Content -LiteralPath $logFile -Value $line } catch { }
}

function Head {
    param([string] $Text)
    Write-Host ""
    Write-Host $Text -ForegroundColor Cyan
    try { Add-Content -LiteralPath $logFile -Value ("{0:u}  == {1}" -f (Get-Date), $Text) } catch { }
}

# ---------------------------------------------------------------------------
# Running Python without this script killing itself
# ---------------------------------------------------------------------------
<#
    Two faults, and both of them only bite in the case that matters most:
    AURION's own interpreter, which is a one-element argv array.

        1. Find-Python returns an argv array - @("py", "-3.12") on a machine
           with the launcher, and @("C:\...\runtime\python\python.exe") for
           AURION's own, one element. The tail was sliced with an
           element-1 range, [1..(Length - 1)], which for one element
           evaluates 1..0 and that is a *descending* range: 1, 0. The line
           became "python.exe <nothing> <python.exe> -c ...", exited 2, and
           never ran the import it was asked for. So the check that decides
           whether the engine's libraries need installing was wrong on every
           machine that uses AURION's own Python - which is all of them.

        2. This script runs with $ErrorActionPreference = "Stop". In Windows
           PowerShell 5.1 a native program that writes to stderr is then a
           terminating error ("NativeCommandError"), and redirecting stderr
           to $null does not stop it. A failing "import numpy" writes a
           traceback to stderr, so the check for the engine's libraries
           killed the script instead of reporting a missing library - with
           no log line, no exit code, and nothing installed.

    Everything below runs a child process with the error preference turned
    down to "Continue" for the duration, so the exit code is the answer and
    never an exception. It is restored afterwards, because the rest of this
    script wants "Stop".
#>
<#
    The argv to hand the interpreter, without the interpreter itself.

    A count check rather than a slice: for a one-element command,
    [1..(Length - 1)] is the descending range 1, 0 - empty for nobody and
    wrong for everybody.
#>
function Get-PythonArgv {
    param([string[]] $Python, [string[]] $Arguments)

    $argv = @()
    if ($Python.Count -gt 1) { $argv += $Python[1..($Python.Count - 1)] }
    if ($Arguments) { $argv += $Arguments }
    return $argv
}

<#
    Run the interpreter, hand back its exit code and everything it printed.

    Nothing goes on screen: this is for questions like "can it import numpy",
    which are answered by an exit code. Never throws.
#>
function Invoke-PythonCaptured {
    param([string[]] $Python, [string[]] $Arguments)

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $text = ""
    $code = 1
    try {
        $argv = @(Get-PythonArgv -Python $Python -Arguments $Arguments | Where-Object { $null -ne $_ })
        $text = (& $Python[0] @argv 2>&1 | Out-String)
        $code = [int]$LASTEXITCODE
    } catch {
        $text = "$_"
        $code = 1
    } finally {
        $ErrorActionPreference = $previous
    }

    $text = "$text"
    return [pscustomobject]@{ ExitCode = $code; Ok = ($code -eq 0); Text = $text }
}

<#
    Run a program and repeat what it says, on screen and in the log.

    pip and npm are the reason this exists. An installation that fails takes
    three minutes and explains itself entirely in its own output, and the one
    thing a person reading setup.log afterwards needs is that output - not
    the four characters "exit code 1".

    stderr is read, not feared: npm writes its deprecation warnings there and
    treats them as success, and with $ErrorActionPreference = "Stop" that
    warning was a terminating error that ended setup in the middle of the
    desk API's packages.
#>
function Invoke-Program {
    param([string] $Program, [string[]] $Arguments, [string] $WorkingDirectory = "")

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $said = @()
    $pushed = $false
    try {
        if ($WorkingDirectory) {
            Push-Location -LiteralPath $WorkingDirectory
            $pushed = $true
        }

        $argv = @($Arguments | Where-Object { $null -ne $_ })
        & $Program @argv 2>&1 | ForEach-Object {
            $line = ("$_" -replace "`r", "").TrimEnd()
            if ($line.Length -eq 0) { return }
            $said += $line
            Write-Host "  $line"
            try { Add-Content -LiteralPath $logFile -Value ("{0:u}  | {1}" -f (Get-Date), $line) } catch { }
        }
    } catch {
        $said += "$_"
        Write-Host "  $_" -ForegroundColor Yellow
    } finally {
        if ($pushed) { Pop-Location }
        $ErrorActionPreference = $previous
    }

    return [pscustomobject]@{
        ExitCode = [int]$LASTEXITCODE
        Text     = (@($said) -join [Environment]::NewLine)
    }
}

<#
    The same thing, for an interpreter that is a command plus its switches -
    "py -3.12" is two words, and AURION's own is one.
#>
function Invoke-PythonStep {
    param([string[]] $Python, [string[]] $Arguments)

    $argv = @(Get-PythonArgv -Python $Python -Arguments $Arguments)
    return (Invoke-Program -Program $Python[0] -Arguments $argv)
}

<#
    Can this interpreter import what the engine needs?

    find_spec would answer faster, but the question is whether importing
    works, and on a machine that has never done it that includes compiling
    several thousand files to bytecode. There is no timeout on purpose.
#>
function Test-EngineImports {
    param([string[]] $Python)
    return (Invoke-PythonCaptured -Python $Python -Arguments @("-c", "import fastapi, numpy, sklearn"))
}

function Test-Pip {
    param([string[]] $Python)
    $probe = Invoke-PythonCaptured -Python $Python -Arguments @("-m", "pip", "--version")
    return [bool]$probe.Ok
}

<#
    Make sure this interpreter has a working pip.

    The embeddable Python ships without one - get-pip.py is what puts it
    there - and an interpreter whose pip was never set up answers every
    "pip install" with "No module named pip" and exit code 1, which is
    indistinguishable from a broken installation. Three ways to fix it, in
    order of how little they need: the standard library's own ensurepip, the
    get-pip.py this build carries, and the PSF's bootstrap over https.
#>
function Enable-Pip {
    param([string[]] $Python, [string] $Work)

    if (Test-Pip -Python $Python) { return $true }

    Say "pip is missing from this Python - setting it up"

    # ensurepip needs nothing from the network: it carries its own copy.
    $step = Invoke-PythonStep -Python $Python -Arguments @("-m", "ensurepip", "--upgrade", "--default-pip")
    if ($step.ExitCode -eq 0 -and (Test-Pip -Python $Python)) {
        Say "pip is ready"
        return $true
    }

    $getPip = Get-Bundled $GetPipName
    if ($getPip) {
        Say "using the get-pip.py that ships with AURION"
    } else {
        $getPip = Join-Path $Work $GetPipName
        Say "downloading get-pip.py from bootstrap.pypa.io"
        Get-File -Url $GetPipUrl -Target $getPip -Label "pip"
    }

    $step = Invoke-PythonStep -Python $Python -Arguments @($getPip, "--no-warn-script-location", "--no-input")
    if ($step.ExitCode -ne 0) {
        Say "get-pip.py finished with code $($step.ExitCode)"
    }

    $ok = Test-Pip -Python $Python
    if ($ok) { Say "pip is ready" } else { Say "pip still does not answer in $($Python[0])" }
    return $ok
}

<#
    Turn pip's last lines into something a person can act on.

    pip reports a network failure as a wall of retry lines and finishes with
    a single sentence naming the host. On a filtered or offline network -
    which is not unusual - the cause is one of four things and each has a
    different fix, so they are worth distinguishing.
#>
function Explain-PipFailure {
    param([string] $Text, [int] $Code)

    $text = "$Text"
    $tips = @()

    if ($text -match "CERTIFICATE_VERIFY_FAILED|certificate verify failed|SSL") {
        $tips += "pip could not make a trusted connection to the package index. A proxy, a filter or an antivirus that inspects TLS is the usual cause."
        $tips += "If this machine reaches a mirror but not pypi.org, point AURION at the mirror and run setup again:"
        $tips += "    setx AURION_PIP_INDEX_URL https://<mirror>/simple"
    }
    if ($text -match "ProxyError|ConnectTimeout|ReadTimeout|ConnectionRefused|Connection refused|Temporary failure in name resolution|getaddrinfo|Network is unreachable|NewConnectionError") {
        $tips += "pip could not reach the package index at all. On a machine with no route to it, copy the wheels from a build machine into vendor\wheels - setup then installs with no network."
    }
    if ($text -match "No matching distribution|Could not find a version") {
        $tips += "The index offered no wheel for this Python. The engine needs CPython 3.10, 3.11 or 3.12 - numpy 1.26.4 has no wheel for 3.13 or newer."
    }
    if ($text -match "Permission denied|Access is denied|WinError 5") {
        $tips += "A file in runtime\python\Lib\site-packages could not be written. An antivirus scanner is the usual cause; close AURION and run setup again."
    }
    if ($tips.Count -eq 0) {
        $tips += "pip's own explanation is in data\logs\setup.log, above this line."
    }
    $tips += "pip finished with code $Code."
    return $tips
}

<#
    Install engine\requirements.txt into an interpreter, and say what
    happened when it does not work.

    This is the step that "it cannot install them" began with: the machine
    had AURION's own Python and none of its libraries, setup said "Python is
    already here", and the next line killed the script - so the libraries
    were never installed, and nothing was written down about why.
#>
function Install-EngineLibraries {
    param([string[]] $Python, [string] $Requirements, [string] $Work)

    Head "Installing the engine's libraries"

    if (-not (Enable-Pip -Python $Python -Work $Work)) {
        throw ("pip does not work in $($Python[0]), so the engine's libraries cannot be installed. " +
               "Run scripts\fix-numpy.ps1 in the installation folder - it sets pip up first - " +
               "or reinstall AURION so its own runtime is put back.")
    }

    # The copies the build bundled, when it bundled them: no PyPI, no proxy,
    # no ninety-megabyte download on somebody else's laptop.
    $wheels = Join-Path $InstallFolder "vendor\wheels"
    $bundled = $false
    if (Test-Path -LiteralPath $wheels) {
        $count = @(Get-ChildItem -LiteralPath $wheels -Filter *.whl -ErrorAction SilentlyContinue).Count
        if ($count -gt 0) { $bundled = $true }
    }

    $arguments = @()
    if ($bundled) {
        Say "installing from the copies that ship with AURION - no download"
        $arguments = @(
            "-m", "pip", "install",
            "--no-index", "--find-links", $wheels,
            "-r", $Requirements,
            "--no-input", "--disable-pip-version-check"
        )
    } else {
        # Upgrading pip is a nicety. On a machine with no network it is
        # where setup appeared to hang for a minute behind the word
        # "Updating pip", so it gets one try, a short timeout, and no
        # opinion if it fails.
        Say "updating pip first ..."
        $null = Invoke-PythonStep -Python $Python -Arguments @(
            "-m", "pip", "install", "--upgrade", "pip",
            "--retries", "1", "--timeout", "15", "--no-input", "--disable-pip-version-check")

        Say "this is the long one - NumPy and scikit-learn are around 90 MB"
        $arguments = @(
            "-m", "pip", "install", "-r", $Requirements,
            "--no-input", "--disable-pip-version-check",
            "--retries", "3", "--timeout", "60"
        )

        # A machine behind a filter can be given a mirror without editing
        # this script - which is the difference between "cannot install" and
        # "installs from the mirror it can reach".
        if ($env:AURION_PIP_INDEX_URL) {
            Say "using the package index in AURION_PIP_INDEX_URL"
            $arguments += @("--index-url", $env:AURION_PIP_INDEX_URL)
        }
    }

    $run = Invoke-PythonStep -Python $Python -Arguments $arguments
    if ($run.ExitCode -ne 0) {
        foreach ($line in @(Explain-PipFailure -Text $run.Text -Code $run.ExitCode)) { Say $line }
        throw "pip could not install the engine's libraries (exit code $($run.ExitCode))."
    }

    $check = Test-EngineImports -Python $Python
    if (-not $check.Ok) {
        foreach ($line in @(Explain-PipFailure -Text $check.Text -Code $check.ExitCode)) { Say $line }
        throw "The engine's libraries were installed but still do not import."
    }

    Say "engine libraries installed"
}

Head "AURION setup"
Say "installation: $InstallFolder"

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

<#
    The best supported interpreter on this machine, as an argv array, or $null.

    Returned as an array rather than a string because "py -3.12" is a command
    and a switch, and gluing them back together is how quoting bugs start.
#>
<#
    Install Python by unpacking it, the way Node is installed here.

    python.org's .exe is an MSI bundle, and Windows allows one installation
    at a time across the machine. A desk started from its own installer's
    finish page races the installer that started it, and the bundle exits
    with a number and nothing else - which is how a machine ended up with
    Node installed and Python not.

    The embeddable build is a zip of files. Nothing to queue behind, no
    elevation, no registry. Two things the full installer would have done
    have to be done here: ._pth ships with "import site" commented out,
    which leaves site-packages switched off and pip pointless; and there is
    no pip, which is what the bundled get-pip.py is for - it carries its
    own copy and needs no network.
#>
function Install-PythonFromZip {
    param([string] $Work)

    $target = Join-Path $InstallFolder "runtime\python"

    # The prepared runtime first: the libraries are inside it, so there is
    # nothing to install afterwards and nothing that could go to the network.
    $zip = Get-Bundled $RuntimeZipName
    if ($zip) {
        Say "unpacking the Python that ships with AURION, libraries included, into $target ..."
    } else {
        $zip = Get-Bundled $PythonZipName
    }
    if ($zip -and (Test-Path -LiteralPath $zip)) {
        Say "unpacking into $target ..."
    } else {
        # Nothing bundled - a build made with -NoBundle, or an older MSI.
        # The same embeddable build is on python.org, and it is a zip, so
        # there is no Authenticode signature to check. What can be checked is
        # that it arrived over https, is the size of a Python, and unpacks
        # into an interpreter that runs - which Find-Python and the pip step
        # below both do, and would fail loudly if it did not.
        $zip = Join-Path $Work $PythonZipName
        Say "downloading the embeddable Python from python.org ..."
        Get-File -Url $PythonZipUrl -Target $zip -Label "Python"
    }

    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $target -Force

    foreach ($pth in Get-ChildItem -LiteralPath $target -Filter "python*._pth" -File) {
        $lines = @(Get-Content -LiteralPath $pth.FullName |
                   ForEach-Object { if ($_.Trim() -eq "#import site") { "import site" } else { $_ } })
        if ($lines -notcontains "import site") { $lines += "import site" }
        if ($lines -notcontains "Lib\site-packages") { $lines += "Lib\site-packages" }
        Set-Content -LiteralPath $pth.FullName -Value $lines
    }
    New-Item -ItemType Directory -Path (Join-Path $target "Lib\site-packages") -Force | Out-Null

    $exe = Join-Path $target "python.exe"
    if (-not (Test-Path -LiteralPath $exe)) { throw "Python unpacked but python.exe is not in $target." }

    # The embeddable build has no pip at all. Enable-Pip uses the bundled
    # get-pip.py when the build carries one, and the PSF's bootstrap when it
    # does not - so this fallback is not one bad build away from failing.
    # Enable-Pip answers immediately when pip is already there, which is the
    # normal case for the prepared runtime: it ships with pip inside it.
    if (-not (Test-Pip -Python @($exe))) {
        Say "setting up pip ..."
        if (-not (Enable-Pip -Python @($exe) -Work $Work)) {
            throw "pip could not be installed into the unpacked Python, so the engine's libraries cannot be."
        }
    }

    Say "Python is ready: $exe"
}

function Find-Python {
    # AURION's own interpreter first. The engine is pinned to NumPy 1.26.4 -
    # the last official Windows wheel that does not require x86-64-v2 - and
    # that wheel exists only for CPython 3.9 to 3.12. Following whatever the
    # machine has meant that upgrading the system Python broke the engine.
    $mine = Join-Path $InstallFolder "runtime\python\python.exe"
    if (Test-Path -LiteralPath $mine) { return @($mine) }

    # An interpreter recorded on an earlier run, unless it has since gone
    # away or is the Store alias. runtime.env is written once and believed
    # afterwards, so a bad choice made on a first run outlived every repair.
    if ($env:AURION_PY -and (Test-Path -LiteralPath $env:AURION_PY) -and
        $env:AURION_PY -notlike "*\WindowsApps\*") {
        return @($env:AURION_PY)
    }

    # py.exe answers "there is no 3.12 here" on stderr, and this script runs
    # with $ErrorActionPreference = "Stop": in Windows PowerShell 5.1 that is
    # a terminating error, and 2>$null does not prevent it. So on a machine
    # with the launcher and no supported Python under it - the ordinary bare
    # machine - the search itself killed setup before it could install
    # anything. The probe is run through the helper, which does not care
    # what a child writes.
    foreach ($v in @("3.12", "3.11", "3.10")) {
        $probe = Invoke-PythonCaptured -Python @("py", "-$v") -Arguments @("-c", "import sys")
        if ($probe.Ok) { return @("py", "-$v") }
    }

    # Where python.org records what it installed.
    #
    # A machine had a working CPython 3.12.7 that AURION could not see: not
    # on PATH because we install with PrependPath=0 on purpose, invisible to
    # `py` because we install with Include_launcher=0 on purpose, and bare
    # `python` resolved to the Store alias, which is refused. Three
    # deliberate decisions adding up to an interpreter that exists, works,
    # and cannot be found. This key is written regardless of all three.
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
    # No launcher, or no versioned entry. Accept a bare `python` only when it
    # is a version the engine actually runs on, and only when it is not the
    # Microsoft Store alias.
    #
    # %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe is not an interpreter,
    # it is an app execution alias. It resolves only inside an interactive
    # session belonging to the user who installed it, it redirects writes
    # away from site-packages, and started detached through wscript it exits
    # without producing output or a log. One machine had it recorded in
    # runtime.env and believed ever since: engine and desk wrote nothing at
    # all, and the launcher returned 1 with no explanation.
    $bare = (Get-Command python -ErrorAction SilentlyContinue |
             Select-Object -First 1 -ExpandProperty Source)
    if ($bare -and $bare -notlike "*\WindowsApps\*") {
        $probe = Invoke-PythonCaptured -Python @("python") -Arguments @(
            "-c", "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)")
        if ($probe.Ok) { return @("python") }
    }
    return $null
}

<#
    node.exe by absolute path. AURION's own copy first: it is the one this
    script installs, it is deliberately not on PATH, and on a machine where
    PATH is stale it is the only one that can be found at all.
#>
function Find-Node {
    $mine = Join-Path $InstallFolder "runtime\node\node.exe"
    if (Test-Path -LiteralPath $mine) { return $mine }

    $onPath = Get-Command node -ErrorAction SilentlyContinue
    if ($onPath -and $onPath.Source -and (Test-Path -LiteralPath $onPath.Source)) { return $onPath.Source }

    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if (Test-Path -LiteralPath $p) { return $p }
    }
    return $null
}

<#
    Rebuild PATH from the registry.

    This process inherited its environment when it started, so a Python
    installed thirty seconds ago is invisible to it until this runs. Without
    it the script would install Python successfully and then report that
    Python could not be found.
#>
function Update-PathFromRegistry {
    try {
        $machine = [Environment]::GetEnvironmentVariable("PATH", "Machine")
        $user    = [Environment]::GetEnvironmentVariable("PATH", "User")
        # Appended, not assigned. .NET expands REG_EXPAND_SZ so this does
        # not hit the problem start-aurion.cmd had, but replacing a working
        # PATH wholesale is still a way to lose tools the process already
        # had - and there is no reason to take it.
        $extra = @($machine, $user) | Where-Object { $_ }
        if ($extra) { $env:PATH = (@($env:PATH) + $extra | Where-Object { $_ }) -join ';' }
    } catch {
        Say "could not re-read PATH from the registry: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# Downloading, with the checks that make it defensible
# ---------------------------------------------------------------------------

function Get-File {
    param([string] $Url, [string] $Target, [string] $Label)

    Say "downloading $Label ..."
    # Invoke-WebRequest's progress bar makes a large download several times
    # slower in Windows PowerShell. The script says what it is doing anyway.
    $previous = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Target -UseBasicParsing
    } finally {
        $ProgressPreference = $previous
    }

    $size = (Get-Item -LiteralPath $Target).Length
    if ($size -lt 100000) {
        Remove-Item -LiteralPath $Target -Force -ErrorAction SilentlyContinue
        throw "The $Label download was too small to be real ($size bytes)."
    }
    Say ("{0} downloaded, {1:N1} MB" -f $Label, ($size / 1MB))
}

<#
    Refuse a file that is not signed by who we expect.

    Checked instead of a pinned hash: a hash pins one exact build and starts
    rejecting the genuine file the day the vendor ships a patch. A publisher
    check keeps being true, and is the same question Windows itself asks.
#>
function Assert-SignedBy {
    param([string] $Path, [string] $Publisher, [string] $Label)

    $sig = Get-AuthenticodeSignature -LiteralPath $Path
    $subject = ""
    if ($sig.SignerCertificate) { $subject = $sig.SignerCertificate.Subject }

    if ($sig.Status -ne "Valid" -or $subject -notlike "*$Publisher*") {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw "The $Label download is not validly signed by $Publisher. It was deleted without being run."
    }
    Say "$Label signature verified: $Publisher"
}

<#
    Match a download against the checksum the vendor publishes next to it.

    A zip carries no Authenticode signature, so the publisher check above
    cannot be used. The checksum list is fetched over https from the same
    origin and is not pinned here, so it stays correct when the pinned
    version is bumped.
#>
<#
    The bundled zip, against the bundled checksum list. Never deletes: this
    file lives in the installation, and removing it would turn a verification
    failure into an install that needs repairing.
#>
function Assert-LocalChecksum {
    param([string] $Path, [string] $SumsFile, [string] $Name)

    $line = Get-Content -LiteralPath $SumsFile |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -match "[\s\*]$([regex]::Escape($Name))$" } |
            Select-Object -First 1
    if (-not $line) { throw "$Name is not listed in the bundled checksum file." }

    $expected = ($line -split '\s+')[0]
    $actual   = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $expected.ToUpperInvariant()) {
        throw "The bundled $Name does not match its checksum. It was not used."
    }
    Say "$Name checksum verified against the bundled list"
}

function Assert-PublishedChecksum {
    param([string] $Path, [string] $SumsUrl, [string] $Name)

    $sums = (Invoke-WebRequest -Uri $SumsUrl -UseBasicParsing).Content
    $line = $sums -split "`n" |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -match "[\s\*]$([regex]::Escape($Name))$" } |
            Select-Object -First 1
    if (-not $line) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw "$Name is not listed in the vendor's checksum file."
    }

    $expected = ($line -split '\s+')[0]
    $actual   = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if ($actual -ne $expected.ToUpperInvariant()) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        throw "The $Name download does not match the checksum published for it. It was deleted without being used."
    }
    Say "$Name checksum verified"
}

# ---------------------------------------------------------------------------
# 1. Python
# ---------------------------------------------------------------------------
$work = Join-Path $env:TEMP "AURION-setup"
New-Item -ItemType Directory -Path $work -Force | Out-Null

$python = Find-Python
if ($SkipPython) {
    Say "skipping Python at your request"
} elseif ($python) {
    Say "Python is already here: $($python -join ' ')"
} elseif (Get-Bundled $RuntimeZipName) {
    # The release path.
    #
    # The runtime zip is a Python with the engine's libraries already inside
    # it, built once on the build machine. Unpacking it is the whole install:
    # no python.org bundle, so nothing to queue behind Windows Installer and
    # nothing that can decline to run; no pip run; no wheels; no network.
    Head "Unpacking the Python that ships with AURION"
    Install-PythonFromZip -Work $work
    $python = Find-Python
    if ($python) {
        Say "Python is ready: $($python -join ' ')"
    } else {
        Say "no Python could be put in place - the engine will not start"
    }
} else {
    Head "Installing Python 3.12"
    $exe = Get-Bundled $PythonExeName
    if ($exe) {
        Say "using the Python that ships with AURION"
    } else {
        $exe = Join-Path $work "python-setup.exe"
        Get-File -Url $PythonUrl -Target $exe -Label "Python"
    }
    Assert-SignedBy -Path $exe -Publisher $PythonPublisher -Label "Python"

    # Per-user on purpose. A desk that installs into %LocalAppData% has no
    # business writing to Program Files, and a per-user Python needs no
    # elevation prompt - which is the whole point of doing it this way.
    # Into AURION's own folder. TargetDir keeps the engine's pinned NumPy
    # safe from anyone upgrading the machine's Python; PrependPath=0 and
    # AssociateFiles=0 because a trading desk has no business owning the
    # PATH or the .py extension; Include_launcher=0 leaves py.exe alone.
    # None of it needs an administrator.
    $target = Join-Path $InstallFolder "runtime\python"
    Say "installing Python into $target (no administrator needed) ..."
    $installLog = Join-Path $InstallFolder "data\logs\python-install.log"
    $p = Start-Process -FilePath $exe -Wait -PassThru -ArgumentList @(
        "/quiet", "/log", "`"$installLog`"",
        "InstallAllUsers=0", "TargetDir=$target",
        "PrependPath=0", "AssociateFiles=0", "Shortcuts=0",
        "Include_launcher=0", "InstallLauncherAllUsers=0",
        "Include_pip=1", "Include_test=0", "Include_doc=0", "Include_tcltk=0")

    # NOT a return.
    #
    # Both of these used to `return`, and at script scope that ends the whole
    # script: the engine's libraries, Node, the desk API's packages and
    # runtime.env were all skipped. A machine that had to unpack Python -
    # which is what happens whenever python.org's bundle declines to install -
    # ended setup there, silently, and was told nothing.
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        Say "the Python installer finished with code $($p.ExitCode); unpacking a copy instead"
        Install-PythonFromZip -Work $work
        $python = Find-Python
    } else {
        Update-PathFromRegistry

        # A zero exit code is not the question; whether there is a python.exe
        # is. When this user already has CPython 3.12.7, the bundle detects
        # its own packages as Present, switches to Modify, plans nothing,
        # ignores TargetDir and exits 0 - a complete success that installed
        # nothing.
        $python = Find-Python
        if (-not $python) {
            Say "the installer had nothing to do and left no Python behind; unpacking a copy instead"
            Install-PythonFromZip -Work $work
            $python = Find-Python
        }
    }

    if ($python) {
        Say "Python is ready: $($python -join ' ')"
    } else {
        Say "no Python could be put in place - the engine will not start"
    }
}

# ---------------------------------------------------------------------------
# 2. The engine's Python libraries
# ---------------------------------------------------------------------------
# This is the step a machine with AURION's Python and none of its libraries
# never reached: the import check below killed the script before it could
# install anything. Both halves of that are fixed in the helpers at the top
# of this file - the argv slice and the stderr-terminates-the-script
# behaviour - so this section now does what it always said it did.
$engineLibsFailed = ""
if ($python) {
    $requirements = Join-Path $InstallFolder "engine\requirements.txt"
    if (-not (Test-Path -LiteralPath $requirements)) {
        Say "engine\requirements.txt is missing - skipping the engine libraries"
        $engineLibsFailed = "engine\requirements.txt is missing from the installation"
    } else {
        $imports = Test-EngineImports -Python $python
        if ($imports.Ok) {
            Say "the engine's libraries are already installed"
        } else {
            try {
                Install-EngineLibraries -Python $python -Requirements $requirements -Work $work
            } catch {
                # One step failing must not abandon the others.
                #
                # This is the same mistake the `return` in section 1 made, in
                # a different shape: Node and the desk's packages have nothing
                # to do with pip, and a machine that ends setup with Node
                # installed is closer to working than one that stopped here.
                # The failure is remembered, said out loud, written to
                # setup.log by the Say above, and reported at the end.
                $engineLibsFailed = "$($_.Exception.Message)"
                Say "the engine's libraries are still not installed: $engineLibsFailed"
                Say "carrying on with Node and the desk's packages - neither depends on pip"
            }
        }
    }
}

# ---------------------------------------------------------------------------
# 3. Node
# ---------------------------------------------------------------------------
$node = Find-Node
if ($SkipNode) {
    Say "skipping Node at your request"
} elseif ($node) {
    Say "Node is already here: $node"
} else {
    Head "Installing Node.js $NodeVersion"
    $zip = Get-Bundled $NodeZipName
    if ($zip) {
        Say "using the Node.js that ships with AURION"
        # fetch-vendor.ps1 bundles nodejs.org's checksum list next to the zip
        # precisely so this can still be checked with no network.
        $localSums = Get-Bundled "SHASUMS256.txt"
        if ($localSums) { Assert-LocalChecksum -Path $zip -SumsFile $localSums -Name $NodeZipName }
    } else {
        $zip = Join-Path $work $NodeZipName
        Get-File -Url $NodeZipUrl -Target $zip -Label "Node.js"
        Assert-PublishedChecksum -Path $zip -SumsUrl $NodeSumsUrl -Name $NodeZipName
    }

    $runtime = Join-Path $InstallFolder "runtime"
    $staging = Join-Path $runtime "node-new"
    $target  = Join-Path $runtime "node"

    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null

    Say "unpacking into $target ..."
    if (Get-Command Expand-Archive -ErrorAction SilentlyContinue) {
        Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force
    } else {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zip, $staging)
    }

    # The zip holds a single node-vX.Y.Z-win-x64 folder. Promote its contents
    # so node.exe sits exactly where Find-Node looks for it.
    $inner = Get-ChildItem -LiteralPath $staging -Directory | Select-Object -First 1
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    if ($inner) { Move-Item -LiteralPath $inner.FullName -Destination $target }
    else        { Move-Item -LiteralPath $staging -Destination $target }
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }

    $node = Find-Node
    if (-not $node) { throw "Node.js unpacked but node.exe is not where it should be." }
    Say "Node is ready: $node"
}

# ---------------------------------------------------------------------------
# 4. The desk API's packages
# ---------------------------------------------------------------------------
if ($node) {
    $backend = Join-Path $InstallFolder "backend"
    if (-not (Test-Path -LiteralPath $backend)) {
        Say "the backend folder is missing - skipping its packages"
    } elseif (Test-Path -LiteralPath (Join-Path $backend "node_modules\express")) {
        Say "the desk API's packages are already installed"
    } else {
        Head "Installing the desk API's packages"
        # npm is run as a script through node, by absolute path, rather than
        # as the npm.cmd shim: the shim is only reachable through a PATH this
        # session may not have, and AURION's own Node is not on PATH at all.
        #
        # Through Invoke-Program for the same reason pip is: npm writes
        # deprecation warnings to stderr on every install, and with
        # $ErrorActionPreference = "Stop" the first warning ended setup in the
        # middle of the desk's packages. It also means npm's own explanation
        # of a failure ends up in setup.log instead of nowhere.
        $cli = Join-Path (Split-Path -Parent $node) "node_modules\npm\bin\npm-cli.js"
        $npm = if (Test-Path -LiteralPath $cli) {
            Invoke-Program -Program $node -Arguments @($cli, "install", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $backend
        } else {
            Invoke-Program -Program "cmd.exe" -Arguments @("/c", "npm", "install", "--omit=dev", "--no-audit", "--no-fund") -WorkingDirectory $backend
        }

        if ($npm.ExitCode -ne 0) {
            Say "npm could not install the desk API's packages (exit code $($npm.ExitCode))."
            Say "If this machine cannot reach registry.npmjs.org, run scripts\fix-npm.ps1, which"
            Say "retries with the registry set explicitly and longer timeouts."
            throw "npm install finished with code $($npm.ExitCode)."
        }
        Say "desk API packages installed"
    }
}

# ---------------------------------------------------------------------------
# 5. Write down where everything ended up
# ---------------------------------------------------------------------------
# start-aurion.cmd reads this before it asks PATH anything. PATH is the one
# thing a console that started before setup cannot trust, and chasing that
# is what used to end in a three-minute timeout.
Head "Recording the runtimes"
$lines = @()
if ($python) {
    # The same argv slice that broke the libraries check was here too, and
    # its failure was quiet: a bad path written into runtime.env is believed
    # by the launcher on the next run. The helper asks the interpreter what
    # it actually is, and only a line that names an existing .exe is kept.
    $probe = Invoke-PythonCaptured -Python $python -Arguments @("-c", "import sys; print(sys.executable)")
    $exe = ($probe.Text -split "`r?`n" |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -like "*.exe" } |
            Select-Object -First 1)
    if ($exe -and (Test-Path -LiteralPath $exe)) { $lines += "PYTHON=$exe" }
}
if ($node) { $lines += "NODE=$node" }

if ($lines.Count -gt 0) {
    $runtimeEnv = Join-Path $InstallFolder "data\runtime.env"
    Set-Content -LiteralPath $runtimeEnv -Value $lines -Encoding ASCII
    foreach ($l in $lines) { Say $l }
} else {
    Say "nothing to record - neither runtime was resolved"
}

# ---------------------------------------------------------------------------
# 6. Say whether it worked
# ---------------------------------------------------------------------------
$ready = $true
if (-not $python) { $ready = $false }
if (-not $node)   { $ready = $false }
if (-not (Test-Path -LiteralPath (Join-Path $InstallFolder "backend\node_modules\express"))) { $ready = $false }

# The engine's libraries are part of "ready".
#
# The launcher asks the same question - can this interpreter import fastapi,
# numpy and scikit-learn - and a script that reported success on an
# interpreter that cannot is how a machine came out of setup with everything
# "installed" and an engine that would not start. The import check is the
# same one that decides whether to install them, so it is already warm.
if ($engineLibsFailed) {
    $ready = $false
} elseif ($python) {
    # Asked again even when the install above said it worked: what matters is
    # whether the interpreter can import them, not whether pip said so.
    $imports = Test-EngineImports -Python $python
    if (-not $imports.Ok) {
        $ready = $false
        Say "the engine's libraries still do not import in $($python -join ' ')"
        foreach ($line in @(Explain-PipFailure -Text $imports.Text -Code $imports.ExitCode)) { Say $line }
    }
}

try { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue } catch { }

Write-Host ""
if ($ready) {
    Write-Host "AURION is ready." -ForegroundColor Green
    if ($Start) {
        $exe = Join-Path $InstallFolder "AURION.exe"
        $cmd = Join-Path $InstallFolder "start-aurion.cmd"
        if (Test-Path -LiteralPath $exe) {
            Write-Host "Starting AURION ..."
            Start-Process -FilePath $exe -WorkingDirectory $InstallFolder
        } elseif (Test-Path -LiteralPath $cmd) {
            Write-Host "Starting AURION ..."
            Start-Process -FilePath $cmd -WorkingDirectory $InstallFolder
        }
    } else {
        Write-Host "Start it from the Start menu, or run start-aurion.cmd."
    }
    exit 0
}

Write-Host "Setup did not finish." -ForegroundColor Yellow
Write-Host "  what it said:  $logFile"
Write-Host "  try again:     powershell -ExecutionPolicy Bypass -File \"$InstallFolder\scripts\provision.ps1\""
Write-Host "  engine only:   powershell -ExecutionPolicy Bypass -File \"$InstallFolder\scripts\fix-numpy.ps1\""
Write-Host ""
Write-Host "On a machine with no route to PyPI, copy the wheels from a build machine"
Write-Host "into $InstallFolder\vendor\wheels and run this again - it installs from"
Write-Host "them with no network at all."
exit 1
