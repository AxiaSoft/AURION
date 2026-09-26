# ---------------------------------------------------------------------------
#  AURION - local key minting (owner machine only)
#
#  Run it with no arguments and it asks for what it needs:
#      .\admin\mint-key.ps1
#
#  Or pass everything up front:
#      .\admin\mint-key.ps1 developer "admin-owner"
#      .\admin\mint-key.ps1 m1 "client@example.com"
#
#  The private seed is never written to disk, never echoed, and never stored
#  outside this PowerShell session. Before anything is minted, the seed is
#  checked against the public key compiled into this build, so a wrong seed is
#  reported immediately instead of producing keys the product would reject.
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string] $Plan,
  [Parameter(Position = 1)][string] $Note,
  [switch] $NoClipboard
)

$ErrorActionPreference = "Stop"

$Here   = $PSScriptRoot
if (-not $Here) { $Here = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root   = Split-Path -Parent $Here
$Engine = Join-Path $Root "engine"
$Script = Join-Path $Here "mint_local.py"

$Plans = [ordered]@{
  "developer" = "admin / owner key - unlimited, verified offline"
  "m1"        = "1 month"
  "m3"        = "3 months"
  "m6"        = "6 months"
  "y1"        = "12 months"
}

function Fail($message) {
  Write-Host ""
  Write-Host "  $message" -ForegroundColor Red
  Write-Host ""
  exit 1
}

Write-Host ""
Write-Host "  AURION key minting" -ForegroundColor White
Write-Host "  ------------------" -ForegroundColor DarkGray

if (-not (Test-Path $Script)) { Fail "admin\mint_local.py is missing next to this script." }
if (-not (Test-Path $Engine)) { Fail "engine\ was not found at $Engine. Run this from the AURION tree." }

# ---------------------------------------------------------------------------
# Python. Minting needs no MetaTrader5, so any CPython 3.10+ will do; 3.12 is
# preferred because that is the supported baseline for the rest of AURION.
# ---------------------------------------------------------------------------
$pyExe = $null
$pyArgs = @()

foreach ($v in @("3.12", "3.11", "3.10", "3.13")) {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -$v -c "import sys" 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $pyExe = "py"; $pyArgs = @("-$v"); break }
  }
}
if (-not $pyExe) {
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd) { $pyExe = $cmd.Source }
}
if (-not $pyExe) {
  Fail "No Python found. Install Python 3.12 from https://www.python.org/downloads/ and try again."
}

$env:PYTHONPATH = if ($env:PYTHONPATH) { "$Engine;$env:PYTHONPATH" } else { $Engine }

# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------
if (-not $Plan) {
  Write-Host ""
  Write-Host "  Which plan?" -ForegroundColor White
  $i = 0
  $order = @()
  foreach ($k in $Plans.Keys) {
    $i++
    $order += $k
    Write-Host ("    {0}) {1,-10} {2}" -f $i, $k, $Plans[$k]) -ForegroundColor Gray
  }
  Write-Host ""
  $answer = (Read-Host "  Number or plan name").Trim()
  if ($answer -match '^\d+$' -and [int]$answer -ge 1 -and [int]$answer -le $order.Count) {
    $Plan = $order[[int]$answer - 1]
  } else {
    $Plan = $answer.ToLower()
  }
}

$Plan = $Plan.ToLower()
if (-not $Plans.Contains($Plan)) {
  Fail "Unknown plan '$Plan'. Valid plans: $($Plans.Keys -join ', ')"
}

# ---------------------------------------------------------------------------
# Note. It is embedded in the key, so it is worth being deliberate about.
# ---------------------------------------------------------------------------
if (-not $Note) {
  $hint = if ($Plan -eq "developer") { "admin-owner" } else { "client@example.com" }
  $Note = (Read-Host "  Note to embed in the key (who it is for) [$hint]").Trim()
  if (-not $Note) { $Note = $hint }
}

# ---------------------------------------------------------------------------
# Private seed
# ---------------------------------------------------------------------------
$seedNames = @("AXIASOFT_KEY_PRIVATE", "AURION_KEY_PRIVATE_HEX", "AURION_KEY_PRIVATE", "KEY_PRIVATE")
$seed = $null
foreach ($n in $seedNames) {
  $v = [Environment]::GetEnvironmentVariable($n)
  if ($v -and $v.Trim()) { $seed = $v.Trim(); break }
}

if (-not $seed) {
  Write-Host ""
  Write-Host "  The Ed25519 private seed is not in this session." -ForegroundColor Yellow
  Write-Host "  Paste it below - 64 hex characters. It is not shown, not saved and" -ForegroundColor Gray
  Write-Host "  not written anywhere; it lives only in this PowerShell session." -ForegroundColor Gray
  Write-Host ""
  $secure = Read-Host "  Private seed" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try   { $seed = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

if ($seed -notmatch '^[0-9a-fA-F]{64}$') {
  Fail "That is not a 64-character hex seed (got $($seed.Length) characters)."
}

# Does this seed actually belong to this build? Minting with the wrong seed
# silently produces keys that every AURION install will reject, so check first.
$verifier = @'
import sys
sys.path.insert(0, sys.argv[1])
from aurion.license.ed25519 import publickey
from aurion.license.material import ED25519_PUBLIC_HEX
derived = publickey(bytes.fromhex(sys.argv[2])).hex()
print("MATCH" if derived == ED25519_PUBLIC_HEX else "MISMATCH " + derived)
'@

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("aurion-seed-check-{0}.py" -f [guid]::NewGuid())
Set-Content -Path $tmp -Value $verifier -Encoding UTF8
try {
  $check = (& $pyExe @pyArgs $tmp $Engine $seed 2>&1 | Out-String).Trim()
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}

if ($check -like "MISMATCH*") {
  Write-Host ""
  Write-Host "  This seed does not match the public key in this build." -ForegroundColor Red
  Write-Host "    expected (engine\aurion\license\material.py)" -ForegroundColor Gray
  Write-Host "    derived  $($check.Substring(9))" -ForegroundColor Gray
  Write-Host ""
  Fail "Keys minted with this seed would be rejected by every AURION install. Nothing was minted."
} elseif ($check -ne "MATCH") {
  Fail "The seed could not be verified:`n$check"
}

Write-Host "  seed verified against this build's public key" -ForegroundColor DarkGray

foreach ($n in $seedNames) { Set-Item -Path "env:$n" -Value $seed }

# ---------------------------------------------------------------------------
# Mint
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host ("  minting {0} for '{1}'" -f $Plan, $Note) -ForegroundColor Gray

$key = (& $pyExe @pyArgs $Script $Plan $Note 2>&1 | Where-Object { $_ -notmatch '^\s*#' } | Out-String).Trim()
$code = $LASTEXITCODE

# The seed leaves the session with us, whatever happened above.
foreach ($n in $seedNames) { Remove-Item -Path "env:$n" -ErrorAction SilentlyContinue }

if ($code -ne 0 -or -not $key) { Fail "Minting failed:`n$key" }

Write-Host ""
Write-Host "  $key" -ForegroundColor Green
Write-Host ""
if ($Plan -eq "developer") {
  Write-Host "  Developer key - unlimited, verified offline, all features." -ForegroundColor DarkGray
} else {
  Write-Host ("  {0} key ({1}). The client activates it in the desk: Upgrade, paste key." -f $Plan.ToUpper(), $Plans[$Plan]) -ForegroundColor DarkGray
}

if (-not $NoClipboard) {
  try {
    Set-Clipboard -Value $key
    Write-Host "  (copied to the clipboard)" -ForegroundColor DarkGray
  } catch {
    # Clipboard is unavailable in some remote sessions; the key is printed above.
  }
}
Write-Host ""
