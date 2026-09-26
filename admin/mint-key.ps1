# Local-only key minting (owner machine only) - PowerShell wrapper.
# Lives in admin\ ; the AURION tree root is one level up.
# Fixes ModuleNotFoundError by setting PYTHONPATH to <root>\engine
# Usage:
#   $env:AURION_KEY_PRIVATE_HEX="your-64-hex-seed"
#   .\admin\mint-key.ps1 developer "admin-owner"
#   .\admin\mint-key.ps1 m1 "client@example.com"

param(
  [Parameter(Mandatory=$false)][string]$Plan,
  [Parameter(Mandatory=$false)][string]$Note = "local"
)

$Here = $PSScriptRoot
if (-not $Here) { $Here = Split-Path -Parent $MyInvocation.MyCommand.Path }
$Root = Split-Path -Parent $Here
$Engine = Join-Path $Root "engine"

# Ensure engine on PYTHONPATH
if ($env:PYTHONPATH) {
  if ($env:PYTHONPATH -notlike "*$Engine*") { $env:PYTHONPATH = "$Engine;$env:PYTHONPATH" }
} else {
  $env:PYTHONPATH = $Engine
}

# Support both env names
if ($env:AURION_KEY_PRIVATE_HEX -and -not $env:AXIASOFT_KEY_PRIVATE) {
  $env:AXIASOFT_KEY_PRIVATE = $env:AURION_KEY_PRIVATE_HEX
}
if ($env:AXIASOFT_KEY_PRIVATE -and -not $env:AURION_KEY_PRIVATE_HEX) {
  $env:AURION_KEY_PRIVATE_HEX = $env:AXIASOFT_KEY_PRIVATE
}

if (-not $Plan) {
  Write-Host "Usage: .\admin\mint-key.ps1 <plan> [note]" -ForegroundColor Yellow
  Write-Host "Plans: m1, m3, m6, y1, developer" -ForegroundColor Yellow
  Write-Host "Example: .\admin\mint-key.ps1 developer `"admin-owner`"" -ForegroundColor Cyan
  Write-Host "Example: .\admin\mint-key.ps1 m1 `"client@example.com`"" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Set private key first:" -ForegroundColor Yellow
  Write-Host '  $env:AURION_KEY_PRIVATE_HEX="your-64-hex-ed25519-seed"' -ForegroundColor Gray
  exit 2
}

$ScriptPath = Join-Path $Here "mint_local.py"

# AURION runs on CPython 3.12 (engine\main.py refuses 3.13+ on Windows).
$PyExe = 'python'
$PyPrefix = @()
try {
  $v = & py -3.12 -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
  if ($LASTEXITCODE -eq 0 -and ([string]$v).Trim() -eq '3.12') {
    $PyExe = 'py'
    $PyPrefix = @('-3.12')
  }
} catch { }

& $PyExe @PyPrefix $ScriptPath $Plan $Note
exit $LASTEXITCODE
