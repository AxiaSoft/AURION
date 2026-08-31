# AURION Windows MSI Builder - Builds MSI installer that installs to C:\Program Files\AURION
# Requires Node.js and electron-builder

param(
    [switch]$InstallDeps
)

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "=== AURION MSI Builder ===" -ForegroundColor Cyan
Write-Host "Target: C:\Program Files\AURION with Desktop Shortcut" -ForegroundColor Green
Write-Host "Installer type: MSI (perMachine)" -ForegroundColor Green
Write-Host ""

$DesktopPkg = Join-Path $Root "apps\desktop\package.json"
if (-not (Test-Path $DesktopPkg)) {
    Write-Error "apps/desktop/package.json not found"
    exit 1
}

Set-Location (Join-Path $Root "apps\desktop")

if ($InstallDeps -or -not (Test-Path "node_modules\electron-builder")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host "Building MSI installer..." -ForegroundColor Cyan
Write-Host "  - Install dir: C:\Program Files\AURION" -ForegroundColor Gray
Write-Host "  - Desktop shortcut: AURION.lnk" -ForegroundColor Gray
Write-Host "  - Start Menu shortcut: AURION" -ForegroundColor Gray
Write-Host "  - PerMachine: true (requires admin)" -ForegroundColor Gray
Write-Host ""

# Build MSI with perMachine = true
$env:USE_HARD_LINKS = "false"
npx electron-builder --win msi --x64 --config.msi.perMachine=true --config.msi.oneClick=false --config.msi.createDesktopShortcut=always --config.msi.createStartMenuShortcut=true

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
    Write-Host "  - Default path: C:\Program Files\AURION\AURION.exe" -ForegroundColor Gray
    Write-Host "  - Desktop: C:\Users\Public\Desktop\AURION.lnk" -ForegroundColor Gray
    Write-Host "  - Start Menu: AURION" -ForegroundColor Gray
    Write-Host "  - Requires admin elevation" -ForegroundColor Gray
} else {
    Write-Error "MSI build failed"
    exit $LASTEXITCODE
}
