<#
    Which Python can this BUILD machine use?

    Dot-source it, then call Find-BuildPython:

        . "$PSScriptRoot\find-build-python.ps1"
        $py = Find-BuildPython        # @("py","-3.12") or @("C:\...\python.exe")
        if (-not $py) { ... }

    Written after a build that failed twice over, in two different
    places, for the same reason. build-msi.ps1 printed

        C:\Users\...\AppData\Local\Microsoft\WindowsApps\python.exe

    as the Python it had found, and then fetch-vendor.ps1 said "No
    Python on this build machine" and stopped the build. Both were
    right, and neither was any help: one had found the Microsoft Store
    alias and believed it, the other had tried the same alias, got a
    non-zero exit, and concluded the machine had nothing - on a machine
    where python.org's 3.12 was installed and working.

    The alias is the heart of it. %LOCALAPPDATA%\Microsoft\WindowsApps\
    python.exe is not an interpreter; it is a stub that opens the
    Microsoft Store. Uninstalling the Store Python LEAVES THE STUB
    BEHIND, still first on PATH, so `Get-Command python` keeps
    answering with it long after there is nothing behind it.

    So this never trusts a name. It asks each candidate where it really
    lives and what version it is, refuses anything under WindowsApps,
    and - unlike a bare `Get-Command` - knows the two places a quiet
    python.org install hides: the registry key it always writes, and
    the folders it installs into when PATH was left alone.

    Order, most specific first:

      1. AURION's own runtime\python, if this tree has one;
      2. the py launcher, 3.12 then 3.11 then 3.10;
      3. HKCU/HKLM Software\Python\PythonCore\<v>\InstallPath;
      4. the usual per-user and machine-wide install folders;
      5. a bare `python`, last, and only if it is 3.10-3.12.

    The engine is pinned to NumPy 1.26.4 - the last official Windows
    wheel that does not need x86-64-v2 - and that wheel exists only for
    CPython 3.9 to 3.12. A 3.13 on the build machine can collect no
    usable wheels, so it is refused here rather than discovered later
    as an MSI that installs and then cannot import numpy.
#>

Set-StrictMode -Version Latest

function Test-BuildPythonCandidate {
    <#  Returns the real executable path, or "" if this candidate is not
        a usable interpreter. One probe answers both questions that
        matter: where it actually is, and whether its version is one the
        engine's wheels exist for. #>
    param([string[]] $Candidate)

    if (-not $Candidate -or $Candidate.Count -lt 1) { return "" }

    $tail = @()
    # Not [1..($Count-1)]: on a one-element array that range is 1,0 in
    # PowerShell, which quietly prepends an empty argument. That exact
    # mistake shipped an MSI with no wheels in it once already.
    if ($Candidate.Count -gt 1) { $tail = @($Candidate[1..($Candidate.Count - 1)]) }

    $script = "import sys; print(sys.executable); print('%d.%d' % sys.version_info[:2])"

    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = @()
    try {
        $out = @(& $Candidate[0] @tail -c $script 2>$null)
        $code = $LASTEXITCODE
    } catch {
        return ""
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { return "" }

    $lines = @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ })
    if ($lines.Count -lt 2) { return "" }

    $exe = $lines[0]
    $ver = $lines[1]

    # The stub, by whichever name it was reached.
    if ($exe -like "*\WindowsApps\*") { return "" }
    if (-not (Test-Path -LiteralPath $exe)) { return "" }

    # NumPy 1.26.4 has no wheel above CPython 3.12.
    try {
        $v = [version] $ver
        if ($v -lt [version] "3.10" -or $v -gt [version] "3.12") { return "" }
    } catch { return "" }

    return $exe
}

function Find-BuildPython {
    <#  Returns an argv array to invoke Python with - @("py","-3.12") or
        @("C:\Python312\python.exe") - or $null. #>
    param([string] $RepoRoot = "")

    $candidates = @()

    if ($RepoRoot) {
        $own = Join-Path $RepoRoot "runtime\python\python.exe"
        if (Test-Path -LiteralPath $own) { $candidates += , @($own) }
    }

    foreach ($v in @("3.12", "3.11", "3.10")) { $candidates += , @("py", "-$v") }

    # Where python.org records what it installed. This key is written
    # even when the installer was told not to touch PATH and not to
    # install the launcher - which is how a perfectly good interpreter
    # becomes invisible to every `Get-Command` on the machine.
    foreach ($v in @("3.12", "3.11", "3.10")) {
        foreach ($hive in @("HKCU:", "HKLM:")) {
            try {
                $key = "$hive\Software\Python\PythonCore\$v\InstallPath"
                $dir = (Get-ItemProperty -Path $key -ErrorAction Stop)."(default)"
                if ($dir) {
                    $exe = Join-Path $dir "python.exe"
                    if (Test-Path -LiteralPath $exe) { $candidates += , @($exe) }
                }
            } catch { }
        }
    }

    # And the folders it uses when nothing was recorded at all.
    foreach ($v in @("312", "311", "310")) {
        foreach ($dir in @(
            (Join-Path $env:LOCALAPPDATA "Programs\Python\Python$v"),
            "C:\Python$v",
            (Join-Path ${env:ProgramFiles} "Python$v")
        )) {
            if (-not $dir) { continue }
            $exe = Join-Path $dir "python.exe"
            if (Test-Path -LiteralPath $exe) { $candidates += , @($exe) }
        }
    }

    $candidates += , @("python")

    foreach ($c in $candidates) {
        $exe = Test-BuildPythonCandidate -Candidate $c
        if ($exe) {
            return [pscustomobject]@{
                Argv = @($c)
                Exe  = $exe
                How  = (@($c) -join " ")
            }
        }
    }
    return $null
}

function Get-BuildPythonAdvice {
    <#  What to say when there is none. The old message - "install
        Python 3.12" - was wrong on the machine that needed it: Python
        3.12 was installed. What was missing was a way to REACH it. #>
    return @(
        "No usable Python was found on this build machine.",
        "",
        "Looked for, in order: this tree's runtime\python, the py launcher",
        "(3.12/3.11/3.10), the python.org registry key, the usual install",
        "folders, and finally a bare 'python'.",
        "",
        "Two things are refused on purpose:",
        "  * %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe - the Microsoft",
        "    Store stub. Uninstalling the Store Python leaves it behind, still",
        "    first on PATH, answering every `where python` with nothing behind it.",
        "  * Python 3.13 or newer - the engine is pinned to NumPy 1.26.4, whose",
        "    last official Windows wheel is for CPython 3.12.",
        "",
        "Fix it with either:",
        "  * install python.org's Python 3.12 with 'py launcher' ticked, or",
        "  * winget install Python.Python.3.12",
        "then open a NEW shell (this one inherited the old PATH) and build again.",
        "",
        "To build anyway, knowing the MSI will need the customer's network:",
        "  -SkipWheels   no wheels and no runtime-python.zip",
        "  -NoBundle     no bundled runtime at all"
    )
}
