# AURION Windows MSI Builder - Builds MSI installer that installs to C:\Program Files\AURION
# Requires Node.js and electron-builder

param(
    [switch]$InstallDeps
)

$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

Write-Host "=== AURION MSI Builder ===" -ForegroundColor Cyan
Write-Host "Target: %LOCALAPPDATA%\Programs\AURION (per user, writable tree)" -ForegroundColor Green
Write-Host "Installer type: MSI (perUser)" -ForegroundColor Green
Write-Host ""

$DesktopPkg = Join-Path $Root "windows-app\desktop\package.json"
if (-not (Test-Path $DesktopPkg)) {
    Write-Error "windows-app/desktop/package.json not found"
    exit 1
}

Set-Location (Join-Path $Root "windows-app\desktop")

if ($InstallDeps -or -not (Test-Path "node_modules\electron-builder")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "Building MSI installer..." -ForegroundColor Cyan
Write-Host "  - Install dir: %LOCALAPPDATA%\Programs\AURION" -ForegroundColor Gray
Write-Host "  - Desktop shortcut: AURION.lnk" -ForegroundColor Gray
Write-Host "  - Start Menu shortcut: AURION" -ForegroundColor Gray
Write-Host "  - PerMachine: false (no admin needed, tree stays writable)" -ForegroundColor Gray
Write-Host ""

$env:USE_HARD_LINKS = "false"
# perMachine must stay false: the app starts node/python from its own tree,
# runs "npm install" into <tree>\backend and writes <tree>\data + <tree>\config
# (backend/src/paths.js, engine/aurion/config.py).  Under Program Files a
# standard user cannot do any of that.
npx electron-builder --win msi --x64 --config.msi.perMachine=false --config.msi.oneClick=false --config.msi.createDesktopShortcut=always --config.msi.createStartMenuShortcut=true

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "✅ MSI built successfully!" -ForegroundColor Green
    $MsiPath = Join-Path $Root "dist\desktop\*.msi"
    $MsiFiles = Get-ChildItem $MsiPath -ErrorAction SilentlyContinue
    foreach ($f in $MsiFiles) {
        Write-Host "  MSI: $($f.FullName) ($([math]::Round($f.Length/1MB,2)) MB)" -ForegroundColor White
    }
    Write-Host ""
    Write-Host "Install behavior:" -ForegroundColor Cyan
    Write-Host "  - Default path: %LOCALAPPDATA%\Programs\AURION\AURION.exe" -ForegroundColor Gray
    Write-Host "  - Desktop: C:\Users\Public\Desktop\AURION.lnk" -ForegroundColor Gray
    Write-Host "  - Start Menu: AURION" -ForegroundColor Gray
    Write-Host "  - No admin elevation required" -ForegroundColor Gray
} else {
    Write-Error "MSI build failed"
    exit $LASTEXITCODE
}
