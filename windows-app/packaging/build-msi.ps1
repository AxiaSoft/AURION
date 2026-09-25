# Build the AURION Windows MSI.
#
# This used to be a placeholder that only printed instructions and pointed at a
# "packaging\build-windows-app.cmd" that does not exist in this tree.  It now
# delegates to the real builder so the documented entry point actually builds.
#
#   powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi.ps1
#   powershell -ExecutionPolicy Bypass -File windows-app\packaging\build-msi.ps1 -InstallDeps

param(
  [switch]$InstallDeps,
  [switch]$TreeOnly
)

$ErrorActionPreference = 'Stop'

if ($PSVersionTable.Platform -and $PSVersionTable.Platform -ne 'Win32NT') {
  Write-Error 'The Windows MSI can only be built on Windows. On Linux use: python3 windows-app/packaging/build-msi.py (needs wixl).'
  exit 1
}

$builder = Join-Path $PSScriptRoot 'build-msi-windows.ps1'
if (-not (Test-Path $builder)) {
  Write-Error "Builder not found: $builder"
  exit 1
}

& $builder -InstallDeps:$InstallDeps -TreeOnly:$TreeOnly
exit $LASTEXITCODE
