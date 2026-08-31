# Clean, light npm install for the AURION desk.
# exceljs was removed — it is what blew up on Node 26 / broken SSL.
#
#   powershell -ExecutionPolicy Bypass -File D:\aurion\scripts\fix-npm.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
Set-Location $Backend

Write-Host "AURION: repairing Node install in $Backend"
Write-Host "Node $(node -v)   npm $(npm -v)"

Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike "*Program Files*" } | Out-Null

if (Test-Path "node_modules") {
  Write-Host "Removing broken node_modules..."
  cmd /c "rmdir /s /q node_modules"
}
if (Test-Path "package-lock.json") { Remove-Item -Force "package-lock.json" }

npm config set registry https://registry.npmjs.org/
npm cache clean --force

# Node 26 sometimes fails TLS mid-tarball (ERR_SSL_CIPHER_OPERATION_FAILED).
# Retry with a longer network timeout; no optional/native addons.
$env:NPM_CONFIG_FETCH_RETRIES = "5"
$env:NPM_CONFIG_FETCH_RETRY_MINTIMEOUT = "20000"
$env:NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT = "120000"

npm install --no-audit --no-fund --no-optional --omit=dev
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "npm still failed. If the error is ERR_SSL_CIPHER_OPERATION_FAILED,"
  Write-Host "npm still failed. Check the network / registry, then run this script again."
  Write-Host "AURION accepts Node 18+ including 26. Python must stay 3.12."
  exit $LASTEXITCODE
}

node -e "require('express'); require('ws'); require('jsonwebtoken'); require('bcryptjs'); console.log('AURION backend modules OK')"
Write-Host ""
Write-Host "Done. Start the desk with:"
Write-Host "  cd D:\aurion\backend"
Write-Host "  node src\index.js"
