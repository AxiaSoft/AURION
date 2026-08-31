# Build AURION-Setup.msi on Windows with WiX (candle/light) if present,
# otherwise copies the wixl-built MSI from dist\ if you already have it.
# Preferred on this tree: run packaging\build-windows-app.cmd which uses Inno/WiX/electron.

param()
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Out = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Write-Host 'On Windows the supported app installer is:'
Write-Host '  1. Double-click install-aurion.cmd  (Python 3.12 + Node 18+ including 26)'
Write-Host '  2. Desktop shortcut AURION created by AURION-Setup.msi'
Write-Host 'If dist\AURION-Setup.msi already exists, copy it to the PC and run it.'
$msi = Join-Path $Out 'AURION-Setup.msi'
if (Test-Path $msi) {
  Write-Host ('Ready: {0}' -f $msi)
} else {
  Write-Host 'MSI is produced in the packaging pipeline (wixl / Inno).'
}
