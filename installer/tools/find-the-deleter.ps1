<#
.SYNOPSIS
    Find out what is removing files from the runtime build, by name.

.DESCRIPTION
    Three builds in a row on one machine ended the same way: python.exe gone
    from a folder nothing in this repository deletes, numpy's __init__.py
    gone with it, Windows Defender reporting no detection, and - on the
    third run - the whole build tree already excluded from Defender.

    Then the obvious question was finally asked:

        Get-CimInstance -Namespace root\SecurityCenter2 -ClassName AntivirusProduct

    and the answer was Windows Defender and nothing else. No third-party
    scanner. So the explanation every message had been assuming for three
    builds - "some other antivirus" - is wrong, and continuing to guess is
    not going to produce a different build.

    This stops guessing. Windows can be told to write an audit record every
    time a file in a folder is deleted, and that record names the process
    that did it. Three runs:

        find-the-deleter.ps1                 what Defender is actually set to
        find-the-deleter.ps1 -Arm            start recording (administrator)
        ... run the build, let it fail ...
        find-the-deleter.ps1 -Report         who deleted what, and when
        find-the-deleter.ps1 -Off            put the machine back

    -Arm and -Off change two things and change them back: the "File System"
    audit subcategory, and an audit entry on the folder being watched.
    Neither blocks anything, neither deletes anything, and -Off restores
    both. Nothing else on the machine is touched.

.PARAMETER Watch
    The folder to watch. Defaults to the runtime build tree,
    installer\vendor\.runtime-build, or whatever AURION_RUNTIME_WORK points
    at if that is set.

.PARAMETER Arm
    Turn on deletion auditing for that folder. Needs an administrator
    PowerShell. Remember to run -Off afterwards.

.PARAMETER Report
    Read back what was recorded. Does not need an administrator if the
    account can read the Security log; run it elevated if it says it cannot.

.PARAMETER Off
    Undo everything -Arm did.

.PARAMETER Hours
    How far back -Report looks. Default 6.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\find-the-deleter.ps1
#>
[CmdletBinding()]
param(
    [string] $Watch = "",
    [switch] $Arm,
    [switch] $Report,
    [switch] $Off,
    [int]    $Hours = 6
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Say  { param([string] $T) Write-Host "  $T" }
function Head { param([string] $T) Write-Host ""; Write-Host $T -ForegroundColor Cyan }
function Good { param([string] $T) Write-Host "  $T" -ForegroundColor Green }
function Warn { param([string] $T) Write-Host "  $T" -ForegroundColor Yellow }
function Fail { param([string] $T) Write-Host "  $T" -ForegroundColor Red }

$installerDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $Watch) {
    if ($env:AURION_RUNTIME_WORK) {
        $Watch = Join-Path $env:AURION_RUNTIME_WORK.Trim() "aurion-runtime-build"
    } else {
        $Watch = Join-Path $installerDir "vendor\.runtime-build"
    }
}

$elevated = $false
try {
    $elevated = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
                ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch { }

Write-Host ""
Write-Host "  What is removing files from the build" -ForegroundColor White
Write-Host "  -------------------------------------" -ForegroundColor DarkGray
Say "watching $Watch"

# ---------------------------------------------------------------------------
# Always: what Defender is actually configured to do
# ---------------------------------------------------------------------------
# Defender being the only antivirus does not make Defender innocent, and it
# does not make an ExclusionPath sufficient. Exclusions cover the scanning
# engine. They do not cover Attack Surface Reduction rules, and they do not
# cover Controlled Folder Access - two features that are off by default,
# are frequently switched on by a company laptop policy, and act on files
# without producing a threat detection. Get-MpThreatDetection returning
# nothing is consistent with both of them.
Head "How Defender is set up on this machine"

if (-not (Get-Command Get-MpPreference -ErrorAction SilentlyContinue)) {
    Warn "Defender's cmdlets are not available here, so none of this can be read."
} else {
    $pref = $null
    $status = $null
    try { $pref = Get-MpPreference -ErrorAction SilentlyContinue } catch { }
    try { $status = Get-MpComputerStatus -ErrorAction SilentlyContinue } catch { }

    if ($status) {
        Say ("real-time protection  {0}" -f $status.RealTimeProtectionEnabled)
        Say ("tamper protection     {0}" -f $status.IsTamperProtected)
    }

    # Is the folder actually covered? An exclusion added for D:\AURION-BUILD
    # covers D:\AURION-BUILD\installer\vendor\.runtime-build underneath it,
    # and an exclusion added in a non-elevated window is not added at all.
    $covered = $false
    $paths = @()
    if ($pref) { try { $paths = @($pref.ExclusionPath) } catch { $paths = @() } }
    foreach ($p in $paths) {
        if (-not $p) { continue }
        if ($Watch.ToLowerInvariant().StartsWith($p.ToLowerInvariant().TrimEnd('\'))) { $covered = $true }
    }
    if ($covered) { Good "the build tree is in Defender's exclusion list" }
    else {
        Fail "the build tree is NOT excluded"
        Say  "  Add-MpPreference -ExclusionPath '$Watch'   (administrator PowerShell)"
    }

    # Controlled Folder Access. "Ransomware protection" in the Windows
    # Security app, and its block list is separate from ExclusionPath.
    if ($pref) {
        $cfa = ""
        try { $cfa = [string] $pref.EnableControlledFolderAccess } catch { }
        if ($cfa -and $cfa -ne "0" -and $cfa -ne "Disabled") {
            Warn "Controlled Folder Access is $cfa - it ignores ExclusionPath and has its own allow list"
            Say  "  Add-MpPreference -ControlledFolderAccessAllowedApplications 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'"
        } else {
            Good "Controlled Folder Access is off"
        }

        # ASR rules. Each id is a GUID with an action: 1 block, 2 audit,
        # 6 warn. Several of them act on executables that were written
        # moments earlier, which is exactly what this build does.
        $ids = @()
        $actions = @()
        try { $ids = @($pref.AttackSurfaceReductionRules_Ids) } catch { }
        try { $actions = @($pref.AttackSurfaceReductionRules_Actions) } catch { }
        $enforcing = @()
        for ($i = 0; $i -lt $ids.Count; $i += 1) {
            # @($null).Count is 1, so a machine with no ASR rules at all
            # arrives here with one empty entry rather than none.
            if (-not $ids[$i]) { continue }
            $action = if ($i -lt $actions.Count) { [string] $actions[$i] } else { "" }
            if ($action -eq "1" -or $action -eq "Enabled" -or $action -eq "6") { $enforcing += $ids[$i] }
        }
        if ($enforcing.Count -gt 0) {
            Warn "$($enforcing.Count) Attack Surface Reduction rule(s) are enforcing:"
            foreach ($id in $enforcing) { Say "    $id" }
            Say "  ASR does not read ExclusionPath. Its own exclusions:"
            Say "    Add-MpPreference -AttackSurfaceReductionOnlyExclusions '$Watch'"
        } else {
            Good "no Attack Surface Reduction rule is enforcing"
        }
    }

    # Defender's own operational log, which records removals whether or not
    # Get-MpThreatDetection still lists them.
    $since = (Get-Date).AddHours(-$Hours)
    $found = 0
    try {
        $events = @(Get-WinEvent -FilterHashtable @{
            LogName   = "Microsoft-Windows-Windows Defender/Operational"
            Id        = 1006, 1007, 1008, 1116, 1117, 1118, 1119, 5007
            StartTime = $since
        } -ErrorAction SilentlyContinue)
        foreach ($e in $events) {
            $text = ($e.Message -replace "\s+", " ")
            if ($text.Length -gt 300) { $text = $text.Substring(0, 300) + "..." }
            Say ("{0:u}  id {1}  {2}" -f $e.TimeCreated, $e.Id, $text)
            $found += 1
        }
    } catch { }
    if ($found -eq 0) { Say "Defender's own log records nothing in the last $Hours hours" }
}

# ---------------------------------------------------------------------------
# -Arm: start recording deletions
# ---------------------------------------------------------------------------
# Two separate switches, and a deletion is only recorded when both are on:
# the system-wide audit policy for file system access, and an audit entry
# (a SACL) on the folder itself saying which accesses to record for whom.
if ($Arm) {
    Head "Recording every deletion in this folder"
    if (-not $elevated) {
        Fail "this needs an administrator PowerShell - nothing was changed"
        exit 1
    }
    if (-not (Test-Path -LiteralPath $Watch)) {
        New-Item -ItemType Directory -Path $Watch -Force | Out-Null
        Say "created $Watch so it can be watched before the build fills it"
    }

    # Success auditing only. Failures are attempts that were refused, and
    # the file in question is gone, so what we want is the one that worked.
    & auditpol.exe /set /subcategory:"File System" /success:enable /failure:disable | Out-Null
    Say "audit policy: File System success auditing on"

    $acl = Get-Acl -LiteralPath $Watch -Audit
    $rule = New-Object System.Security.AccessControl.FileSystemAuditRule(
        "Everyone",
        [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles,
        [System.Security.AccessControl.InheritanceFlags]"ContainerInherit, ObjectInherit",
        [System.Security.AccessControl.PropagationFlags]::None,
        [System.Security.AccessControl.AuditFlags]::Success)
    $acl.AddAuditRule($rule)
    Set-Acl -LiteralPath $Watch -AclObject $acl
    Good "this folder now records who deletes anything inside it"

    Write-Host ""
    Say "Now run the build and let it fail exactly as before:"
    Say "    powershell -ExecutionPolicy Bypass -File installer\tools\build-msi.ps1"
    Say "Then:"
    Say "    powershell -ExecutionPolicy Bypass -File installer\tools\find-the-deleter.ps1 -Report"
    Say "and when you are done:"
    Say "    powershell -ExecutionPolicy Bypass -File installer\tools\find-the-deleter.ps1 -Off"
    Write-Host ""
}

# ---------------------------------------------------------------------------
# -Report: read it back
# ---------------------------------------------------------------------------
if ($Report) {
    Head "What deleted files in this folder"
    $since = (Get-Date).AddHours(-$Hours)
    $rows = @()
    try {
        # 4663 is the access itself and carries the process; 4660 is the
        # deletion, and on its own it does not name the file. 4663 with
        # DELETE in the access list is the one worth reading.
        $events = @(Get-WinEvent -FilterHashtable @{
            LogName   = "Security"
            Id        = 4663, 4660
            StartTime = $since
        } -ErrorAction SilentlyContinue)
    } catch {
        Fail "the Security log could not be read: $($_.Exception.Message)"
        Say  "Run this in an administrator PowerShell."
        exit 1
    }

    foreach ($e in $events) {
        # One malformed record must not end the report. Under StrictMode a
        # missing EventData is an exception, not an empty value.
        $data = @{}
        try {
            $xml = [xml] $e.ToXml()
            foreach ($d in $xml.Event.EventData.Data) { $data[$d.Name] = $d.'#text' }
        } catch {
            continue
        }
        if ($data.Count -eq 0) { continue }

        $object = ""
        if ($data.ContainsKey("ObjectName")) { $object = [string] $data["ObjectName"] }
        if (-not $object) { continue }
        if (-not $object.ToLowerInvariant().StartsWith($Watch.ToLowerInvariant())) { continue }

        $accesses = ""
        if ($data.ContainsKey("AccessList")) { $accesses = [string] $data["AccessList"] }
        if ($e.Id -eq 4663 -and $accesses -and ($accesses -notmatch "1537|DELETE|Delete")) { continue }

        $who = ""
        if ($data.ContainsKey("ProcessName")) { $who = [string] $data["ProcessName"] }
        $rows += [pscustomobject]@{
            When    = $e.TimeCreated
            Process = $who
            File    = $object
        }
    }

    if ($rows.Count -eq 0) {
        Warn "nothing was recorded for $Watch in the last $Hours hours."
        Say  "Either -Arm was not run before the build, or the deletions happened"
        Say  "outside that window. Both are worth ruling out before concluding"
        Say  "that nothing deleted anything."
        exit 0
    }

    # Who did it, loudest first. One line per process is the answer; the
    # file list underneath is the evidence for it.
    $byProcess = $rows | Group-Object Process | Sort-Object Count -Descending
    foreach ($g in $byProcess) {
        $name = $g.Name
        if (-not $name) { $name = "(not recorded)" }
        Write-Host ""
        Write-Host ("  $($g.Count) deletion(s) by $name") -ForegroundColor Yellow
        foreach ($r in ($g.Group | Sort-Object When | Select-Object -First 12)) {
            Say ("    {0:HH:mm:ss}  {1}" -f $r.When, $r.File)
        }
        if ($g.Count -gt 12) { Say ("    ... and $($g.Count - 12) more") }
    }

    Write-Host ""
    Say "The process named above is the answer. If it is powershell.exe or"
    Say "python.exe it is this build's own work - the trim step and pip both"
    Say "delete a great many files legitimately. Anything else is the thing"
    Say "that has cost three builds."
    Write-Host ""
}

# ---------------------------------------------------------------------------
# -Off: put it back
# ---------------------------------------------------------------------------
if ($Off) {
    Head "Putting the machine back"
    if (-not $elevated) {
        Fail "this needs an administrator PowerShell - nothing was changed"
        exit 1
    }
    if (Test-Path -LiteralPath $Watch) {
        try {
            $acl = Get-Acl -LiteralPath $Watch -Audit
            $removed = 0
            foreach ($r in @($acl.Audit)) {
                $acl.RemoveAuditRule($r) | Out-Null
                $removed += 1
            }
            Set-Acl -LiteralPath $Watch -AclObject $acl
            Say "removed $removed audit entr(ies) from $Watch"
        } catch {
            Warn "the audit entry could not be removed: $($_.Exception.Message)"
        }
    }
    & auditpol.exe /set /subcategory:"File System" /success:disable /failure:disable | Out-Null
    Good "audit policy back to not recording file access"
    Write-Host ""
}

if (-not $Arm -and -not $Report -and -not $Off) {
    Head "What to do next"
    Say "Nothing above proves anything on its own. To catch it in the act,"
    Say "in an administrator PowerShell:"
    Say ""
    Say "    powershell -ExecutionPolicy Bypass -File installer\tools\find-the-deleter.ps1 -Arm"
    Say "    powershell -ExecutionPolicy Bypass -File installer\tools\build-msi.ps1"
    Say "    powershell -ExecutionPolicy Bypass -File installer\tools\find-the-deleter.ps1 -Report"
    Say "    powershell -ExecutionPolicy Bypass -File installer\tools\find-the-deleter.ps1 -Off"
    Say ""
    Say "In the meantime the build no longer needs the answer: a damaged"
    Say "runtime is reinstalled from the bundled wheels and the build"
    Say "finishes. Assembling it somewhere else is the cheapest workaround:"
    Say ""
    Say "    `$env:AURION_RUNTIME_WORK = 'C:\rtbuild'"
    Write-Host ""
}
