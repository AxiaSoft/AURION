<#
.SYNOPSIS
    Builds AURION-<version>-x64.msi end to end.

.DESCRIPTION
    One command, four steps:

      1. tool check      .NET SDK 6+ and the WiX 5 MSBuild SDK (restored by NuGet)
      2. branding        regenerate installer assets if they are missing
      3. payload         installer\build\stage.ps1
      4. compile         dotnet build installer\AURION.wixproj  (full ICE validation)

    The result lands in installer\output\ together with a SHA-256 file.

.PARAMETER Version
    Overrides AurionVersion from Version.props for this build only. Useful for
    CI ("1.2.3") - for a real release, edit Version.props and commit it.

.PARAMETER CertThumbprint
    Authenticode-sign the finished MSI with this certificate from the current
    user's store. Unsigned MSIs make SmartScreen shout at your customers, so
    sign every public release.

.PARAMETER SkipNpm
    Passed through to stage.ps1. Local iteration only.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\build\build-msi.ps1

.EXAMPLE
    .\build-msi.ps1 -Version 1.1.0 -CertThumbprint 9A8B7C...
#>
[CmdletBinding()]
param(
    [string] $Version,
    [string] $CertThumbprint,
    [switch] $SkipNpm,
    [ValidateSet("Release", "Debug")] [string] $Configuration = "Release"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installerDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$repoRoot     = (Resolve-Path (Join-Path $installerDir "..")).Path
$project      = Join-Path $installerDir "AURION.wixproj"
$assetsDir    = Join-Path $installerDir "assets\generated"
$outputDir    = Join-Path $installerDir "output"

function Step([string] $text) {
    Write-Host ""
    Write-Host "== $text" -ForegroundColor Cyan
}

Write-Host ""
Write-Host "  AURION installer build" -ForegroundColor White
Write-Host "  ----------------------" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. Tools
# ---------------------------------------------------------------------------
Step "Checking tools"

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
    throw @"
.NET SDK not found.

WiX 5 is distributed as a NuGet-based MSBuild SDK, so building the MSI needs
the .NET SDK (6.0 or newer) on this machine:

    https://dotnet.microsoft.com/download

Nothing else is required - NuGet restores the WiX toolset itself on first build.
"@
}
Write-Host ("  dotnet {0}" -f (& dotnet --version)) -ForegroundColor Gray

if (-not $PSBoundParameters.ContainsKey('Version') -or [string]::IsNullOrWhiteSpace($Version)) {
    $propsXml = [xml](Get-Content (Join-Path $installerDir "Version.props"))
    $Version = $propsXml.Project.PropertyGroup.AurionVersion
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version '$Version' is not valid. Windows Installer compares major.minor.build only - use three numeric fields."
}
Write-Host "  building version $Version" -ForegroundColor Gray

# ---------------------------------------------------------------------------
# 2. Branding assets
# ---------------------------------------------------------------------------
Step "Branding assets"

$needAssets = @("aurion.ico", "banner.bmp", "dialog.bmp", "info.ico",
                "exclamation.ico", "new.ico", "up.ico") |
              Where-Object { -not (Test-Path (Join-Path $assetsDir $_)) }

if ($needAssets.Count -eq 0) {
    Write-Host "  assets present (delete installer\assets\generated to rebuild them)" -ForegroundColor Gray
} else {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
    if (-not $py) {
        throw "Missing assets: $($needAssets -join ', '). Install Python and run installer\assets\build-assets.py, or restore the files from source control."
    }
    Write-Host "  generating from the application artwork" -ForegroundColor Gray
    & $py.Source (Join-Path $installerDir "assets\build-assets.py")
    if ($LASTEXITCODE -ne 0) { throw "Asset generation failed. Try: pip install Pillow fonttools brotli" }
}

# ---------------------------------------------------------------------------
# 3. Payload
# ---------------------------------------------------------------------------
Step "Staging payload"
& (Join-Path $PSScriptRoot "stage.ps1") -Root $repoRoot -SkipNpm:$SkipNpm
if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { throw "Staging failed." }

# ---------------------------------------------------------------------------
# 4. Compile
# ---------------------------------------------------------------------------
Step "Compiling MSI"

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$binlog = Join-Path $outputDir "build.binlog"

& dotnet build $project `
    -c $Configuration `
    -p:AurionVersion=$Version `
    -p:OutputPath="$outputDir\" `
    -bl:"$binlog"

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  Build failed. A full MSBuild binary log is at:" -ForegroundColor Red
    Write-Host "    $binlog" -ForegroundColor Red
    Write-Host "  Open it with https://msbuildlog.com for the exact failing task." -ForegroundColor Red
    exit 1
}

$msi = Get-ChildItem $outputDir -Filter "AURION-$Version-x64.msi" | Select-Object -First 1
if (-not $msi) { throw "Build reported success but no MSI was produced in $outputDir." }

# ---------------------------------------------------------------------------
# 5. Sign (optional but expected for public releases)
# ---------------------------------------------------------------------------
if ($CertThumbprint) {
    Step "Signing"
    $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match "x64" } |
                Sort-Object FullName -Descending | Select-Object -First 1
    if (-not $signtool) { throw "signtool.exe not found. Install the Windows SDK, or sign the MSI on your signing machine." }

    & $signtool.FullName sign /sha1 $CertThumbprint /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /d "AURION" $msi.FullName
    if ($LASTEXITCODE -ne 0) { throw "Signing failed." }
    Write-Host "  signed" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "  NOTE: the MSI is unsigned. Sign public releases with -CertThumbprint." -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 6. Report
# ---------------------------------------------------------------------------
$hash = (Get-FileHash $msi.FullName -Algorithm SHA256).Hash
Set-Content -Path "$($msi.FullName).sha256" -Value "$hash  $($msi.Name)" -Encoding ASCII

Write-Host ""
Write-Host "  BUILD OK" -ForegroundColor Green
Write-Host ("  {0}" -f $msi.FullName)
Write-Host ("  {0} MB" -f [math]::Round($msi.Length / 1MB, 1))
Write-Host ("  SHA-256 {0}" -f $hash) -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Try it:" -ForegroundColor White
Write-Host "    msiexec /i `"$($msi.Name)`"                      full wizard"
Write-Host "    msiexec /i `"$($msi.Name)`" /qn                  silent install"
Write-Host "    msiexec /i `"$($msi.Name)`" /l*v install.log     with a verbose log"
Write-Host "    msiexec /x `"$($msi.Name)`"                      uninstall wizard"
Write-Host ""
