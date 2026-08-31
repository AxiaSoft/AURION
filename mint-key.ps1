# Local-only key minting (owner machine only) - PowerShell wrapper
# Fixes ModuleNotFoundError by setting PYTHONPATH to engine\
# Usage:
#   $env:AURION_KEY_PRIVATE_HEX="9090ebd8..."
#   .\mint-key.ps1 developer "admin-owner"
#   .\mint-key.ps1 m1 "client@example.com"

param(
  [Parameter(Mandatory=$false)][string]$Plan,
  [Parameter(Mandatory=$false)][string]$Note = "local"
)

$Root = $PSScriptRoot
if (-not $Root) { $Root = Split-Path -Parent $MyInvocation.MyCommand.Path }
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
  Write-Host "Usage: .\mint-key.ps1 <plan> [note]" -ForegroundColor Yellow
  Write-Host "Plans: m1, m3, m6, y1, developer" -ForegroundColor Yellow
  Write-Host "Example: .\mint-key.ps1 developer `"admin-owner`"" -ForegroundColor Cyan
  Write-Host "Example: .\mint-key.ps1 m1 `"client@example.com`"" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Set private key first:" -ForegroundColor Yellow
  Write-Host '  $env:AURION_KEY_PRIVATE_HEX="9090ebd82348b326eb891e496f2f5c1746a53243625237411835a810686826dc"' -ForegroundColor Gray
  exit 2
}

$ScriptPath = Join-Path $Root "scripts\mint_local.py"
python $ScriptPath $Plan $Note
