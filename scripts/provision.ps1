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

# TLS 1.2 is not the default on an un-updated Windows PowerShell 5.1, and
# both python.org and nodejs.org refuse anything older.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# ---------------------------------------------------------------------------
# Where the runtimes come from
# ---------------------------------------------------------------------------
# Official vendor URLs, https only. The Python version is pinned to one the
# engine supports: engine/requirements.txt pins numpy 1.26.4, which has no
# wheels for 3.13, and engine/main.py refuses to start on it.
$PythonExeName   = "python-3.12.7-amd64.exe"
$PythonUrl       = "https://www.python.org/ftp/python/3.12.7/$PythonExeName"
$PythonPublisher = "Python Software Foundation"
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

    foreach ($v in @("3.12", "3.11", "3.10")) {
        try {
            $null = & py "-$v" -c "import sys" 2>$null
            if ($LASTEXITCODE -eq 0) { return @("py", "-$v") }
        } catch { }
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
        try {
            $null = & python -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)" 2>$null
            if ($LASTEXITCODE -eq 0) { return @("python") }
        } catch { }
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
    $p = Start-Process -FilePath $exe -Wait -PassThru -ArgumentList @(
        "/quiet", "InstallAllUsers=0", "TargetDir=$target",
        "PrependPath=0", "AssociateFiles=0", "Shortcuts=0",
        "Include_launcher=0", "InstallLauncherAllUsers=0",
        "Include_pip=1", "Include_test=0", "Include_doc=0", "Include_tcltk=0")
    if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
        throw "The Python installer finished with code $($p.ExitCode)."
    }

    Update-PathFromRegistry
    $python = Find-Python
    if (-not $python) {
        throw "Python was installed but could not be found afterwards. Expected it at $target\python.exe."
    }
    Say "Python is ready: $($python -join ' ')"
}

# ---------------------------------------------------------------------------
# 2. The engine's Python libraries
# ---------------------------------------------------------------------------
if ($python) {
    $requirements = Join-Path $InstallFolder "engine\requirements.txt"
    if (-not (Test-Path -LiteralPath $requirements)) {
        Say "engine\requirements.txt is missing - skipping the engine libraries"
    } else {
        & $python[0] @($python[1..($python.Length - 1)]) -c "import fastapi, numpy, sklearn" 2>$null
        if ($LASTEXITCODE -eq 0) {
            Say "the engine's libraries are already installed"
        } else {
            Head "Installing the engine's libraries"
            # Upgrading pip is a nicety; on a machine with no network it
            # fails, and that must not throw away a good offline bundle.
            try { & $python[0] @($python[1..($python.Length - 1)]) -m pip install --upgrade pip --quiet } catch { }

            $wheels = Join-Path $InstallFolder "vendor\wheels"
            if ((Test-Path -LiteralPath $wheels) -and
                (Get-ChildItem -LiteralPath $wheels -Filter *.whl -ErrorAction SilentlyContinue)) {
                Say "installing from the copies that ship with AURION - no download"
                & $python[0] @($python[1..($python.Length - 1)]) -m pip install `
                    --no-index --find-links $wheels -r $requirements --quiet
            } else {
                Say "this is the long one - NumPy and scikit-learn are around 90 MB"
                & $python[0] @($python[1..($python.Length - 1)]) -m pip install -r $requirements --quiet
            }
            if ($LASTEXITCODE -ne 0) { throw "pip install finished with code $LASTEXITCODE." }
            Say "engine libraries installed"
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
        $cli = Join-Path (Split-Path -Parent $node) "node_modules\npm\bin\npm-cli.js"
        Push-Location $backend
        try {
            if (Test-Path -LiteralPath $cli) {
                & $node $cli install --omit=dev --no-audit --no-fund
            } else {
                & cmd /c "npm install --omit=dev --no-audit --no-fund"
            }
            if ($LASTEXITCODE -ne 0) { throw "npm install finished with code $LASTEXITCODE." }
        } finally {
            Pop-Location
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
    $exe = (& $python[0] @($python[1..($python.Length - 1)]) -c "import sys; print(sys.executable)" 2>$null | Select-Object -First 1)
    if ($exe -and (Test-Path -LiteralPath $exe.Trim())) { $lines += "PYTHON=$($exe.Trim())" }
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

Write-Host "Setup did not finish. The log is here:" -ForegroundColor Yellow
Write-Host "    $logFile"
exit 1
