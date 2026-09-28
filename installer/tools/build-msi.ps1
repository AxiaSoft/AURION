<#
.SYNOPSIS
    Builds AURION-<version>-x64.msi end to end.

.DESCRIPTION
    One command, four steps:

      1. tool check      .NET SDK 6+ and the WiX 5 MSBuild SDK (restored by NuGet)
      2. branding        regenerate installer assets if they are missing
      3. payload         installer\tools\stage.ps1
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

.PARAMETER InstallDotnet
    If the .NET SDK is missing, fetch Microsoft's official dotnet-install.ps1
    and install the SDK per-user into %LocalAppData%\Microsoft\dotnet. No
    administrator rights, nothing machine-wide, nothing else touched.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File installer\tools\build-msi.ps1

.EXAMPLE
    # first time on a machine without the .NET SDK
    .\build-msi.ps1 -InstallDotnet

.EXAMPLE
    .\build-msi.ps1 -Version 1.1.0 -CertThumbprint 9A8B7C...
#>
[CmdletBinding()]
param(
    [string] $Version,
    [string] $CertThumbprint,
    [switch] $SkipNpm,
    [switch] $InstallDotnet,
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

# Bumped whenever this script changes, so a stale copy is obvious at a glance
# instead of failing with a confusing parameter error.
$ScriptRevision = "17"

Write-Host ""
Write-Host "  AURION installer build" -ForegroundColor White
Write-Host "  ----------------------" -ForegroundColor DarkGray
Write-Host "  build script revision $ScriptRevision" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 1. Tools
# ---------------------------------------------------------------------------
Step "Checking tools"

# WiX 5 ships as a NuGet-based MSBuild SDK, so the one hard requirement is the
# .NET *SDK* (the runtime alone is not enough - it has no MSBuild). Find it
# properly: "dotnet" on PATH may be a runtime-only install, and a perfectly good
# SDK is often installed but not on PATH at all.
function Find-DotnetSdk {
    $candidates = @()
    $onPath = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($onPath) { $candidates += $onPath.Source }
    $candidates += @(
        (Join-Path $env:ProgramFiles "dotnet\dotnet.exe"),
        (Join-Path $env:LOCALAPPDATA "Microsoft\dotnet\dotnet.exe"),
        "C:\Program Files\dotnet\dotnet.exe"
    )
    $usable = @($candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique)
    foreach ($exe in $usable) {
        $sdks = @(& $exe --list-sdks 2>$null)
        if ($LASTEXITCODE -eq 0 -and $sdks.Count -gt 0) {
            $newest = @($sdks | ForEach-Object { ($_ -split ' ')[0] } |
                        Where-Object { $_ -match '^\d+' } |
                        Sort-Object { [version]($_ -split '-')[0] } -Descending |
                        Select-Object -First 1)[0]
            if ([version](($newest -split '-')[0]) -ge [version]"6.0.0") {
                return [pscustomobject]@{ Exe = $exe; Sdk = $newest }
            }
        }
    }
    return $null
}

function Install-DotnetSdk {
    # Microsoft's official per-user bootstrapper. No administrator rights, no
    # machine-wide change: everything lands in %LocalAppData%\Microsoft\dotnet.
    $target = Join-Path $env:LOCALAPPDATA "Microsoft\dotnet"
    $script = Join-Path $env:TEMP "dotnet-install.ps1"

    Write-Host "  downloading the official .NET install script from https://dot.net ..." -ForegroundColor Gray
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri "https://dot.net/v1/dotnet-install.ps1" -OutFile $script

    Write-Host "  installing .NET SDK 8.0 into $target (no admin rights needed) ..." -ForegroundColor Gray
    & $script -Channel 8.0 -InstallDir $target -NoPath
    if ($LASTEXITCODE -ne 0) { throw "dotnet-install.ps1 failed with exit code $LASTEXITCODE" }

    # Make it usable for the rest of this session.
    $env:PATH = "$target;$env:PATH"
    $env:DOTNET_ROOT = $target
    Remove-Item $script -ErrorAction SilentlyContinue
}

$found = Find-DotnetSdk

# Offer the per-user bootstrap instead of just refusing to work. -InstallDotnet
# is only needed to skip this question (unattended / CI runs).
if (-not $found -and -not $InstallDotnet -and [Environment]::UserInteractive) {
    Write-Host ""
    Write-Host "  The .NET SDK is required to build an MSI and was not found." -ForegroundColor Yellow
    Write-Host "  It can be installed for your user only, in %LocalAppData%\Microsoft\dotnet," -ForegroundColor Yellow
    Write-Host "  without administrator rights and without changing anything machine-wide." -ForegroundColor Yellow
    $answer = Read-Host "  Install the .NET SDK now? [Y/n]"
    if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match '^(y|yes)$') { $InstallDotnet = $true }
}

if (-not $found -and $InstallDotnet) {
    Install-DotnetSdk
    $found = Find-DotnetSdk
    if (-not $found) { throw ".NET SDK still not detected after bootstrap. Open a new shell and re-run this script." }
}

if (-not $found) {
    $winget = Get-Command winget -ErrorAction SilentlyContinue
    $wingetHint = if ($winget) { "    winget install Microsoft.DotNet.SDK.8`n" } else { "" }
    throw @"
.NET SDK 6.0 or newer was not found on this machine.

WiX 5 is an MSBuild SDK delivered through NuGet, so building the MSI needs the
.NET *SDK*. The .NET Runtime alone is not enough - it has no MSBuild.

Pick whichever you prefer:

  1. Let this script install it for you, per-user, no administrator rights:

         .\build-msi.ps1 -InstallDotnet

  2. Install it yourself:
$wingetHint    https://dotnet.microsoft.com/download/dotnet/8.0   (choose "SDK", x64)

If the SDK IS installed but not on PATH, this script also looks in
  %ProgramFiles%\dotnet  and  %LocalAppData%\Microsoft\dotnet
so a fresh shell after installing is usually all it takes.
"@
}

$dotnetExe = $found.Exe
Write-Host ("  .NET SDK {0}" -f $found.Sdk) -ForegroundColor Gray
Write-Host ("  {0}" -f $dotnetExe) -ForegroundColor DarkGray

# npm is needed by stage.ps1 to restore the desk's production dependencies.
if (-not $SkipNpm -and -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw @"
npm was not found, and the payload needs backend\node_modules to be restored.

Install Node.js 18 or newer from https://nodejs.org and re-run this script.
(Node is also what AURION itself runs on, so the build machine needs it anyway.)
"@
}

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

# @() matters: Where-Object returns $null when every asset is present, and
# $null has no .Count under Set-StrictMode.
$needAssets = @(@("aurion.ico", "banner.bmp", "dialog.bmp", "info.ico",
                  "exclamation.ico", "new.ico", "up.ico") |
                Where-Object { -not (Test-Path (Join-Path $assetsDir $_)) })

if ($needAssets.Count -eq 0) {
    Write-Host "  assets present" -ForegroundColor Gray
} else {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if (-not $py) { $py = Get-Command python -ErrorAction SilentlyContinue }
    if (-not $py) {
        throw ("Missing assets: {0}.`n" -f ($needAssets -join ', ')) +
              "  These are committed to the repository, so the quickest fix is:`n" +
              "      git checkout -- installer/assets/generated`n" +
              "  To regenerate them instead you need Python with Pillow."
    }
    Write-Host "  generating from the application artwork" -ForegroundColor Gray
    & $py.Source (Join-Path $installerDir "assets\build-assets.py")
    if ($LASTEXITCODE -ne 0) {
        throw "Asset generation failed.`n" +
              "  The generated assets are committed, so you normally do not need to build them:`n" +
              "      git checkout -- installer/assets/generated`n" +
              "  Only rebuild them after changing the branding, which needs:`n" +
              "      pip install Pillow fonttools brotli"
    }
}

# ---------------------------------------------------------------------------
# 3. Payload
# ---------------------------------------------------------------------------
Step "Staging payload"
# stage.ps1 throws on failure; $ErrorActionPreference = "Stop" turns that into
# a terminating error here, so there is nothing extra to check. ($LASTEXITCODE
# is deliberately not read: it may not exist yet, which StrictMode rejects.)
& (Join-Path $PSScriptRoot "stage.ps1") -Root $repoRoot -SkipNpm:$SkipNpm

# ---------------------------------------------------------------------------
# 3b. The desk window
#
# AURION.exe is the installer-owned WebView2 host that shows the desk in a real
# window. It is published self-contained, so the trader's machine needs no .NET
# runtime, and it lands directly in the staged payload next to start-aurion.cmd,
# where Files.wxs harvests it with everything else.
# ---------------------------------------------------------------------------
Step "Building the desk window"

$windowProject = Join-Path $installerDir "window\AurionWindow.csproj"
$stageApp = Join-Path $installerDir "stage\app"

& $dotnetExe publish $windowProject `
    -c $Configuration `
    -r win-x64 `
    --self-contained true `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:EnableCompressionInSingleFile=true `
    -p:AurionVersion=$Version `
    -o $stageApp `
    --nologo -v quiet

if ($LASTEXITCODE -ne 0) { throw "Building the desk window (AURION.exe) failed." }

$windowExe = Join-Path $stageApp "AURION.exe"
if (-not (Test-Path $windowExe)) { throw "AURION.exe was not produced in $stageApp." }

# A self-contained single-file publish also drops its own .pdb and the
# deps/runtimeconfig files next to the exe; none of them belong in a shipped
# payload, and leaving them would put ~100 unnecessary files in the MSI.
Get-ChildItem $stageApp -File |
    Where-Object { $_.Extension -in @(".pdb", ".xml") -or $_.Name -like "*.deps.json" } |
    Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host ("  AURION.exe  {0:N1} MB" -f ((Get-Item $windowExe).Length / 1MB)) -ForegroundColor Gray

# ---------------------------------------------------------------------------
# 4. Compile
# ---------------------------------------------------------------------------
Step "Compiling MSI"

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$binlog = Join-Path $outputDir "build.binlog"

# MSBuild keeps its own bin\ layout and the MSI is copied out afterwards.
# OutputPath is deliberately NOT overridden: a quoted property ending in "\"
# escapes the closing quote, which breaks on any path containing a space
# (for example "D:\AURION BETA").
& $dotnetExe build $project `
    -c $Configuration `
    -p:AurionVersion=$Version `
    -bl:"$binlog"

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "  Build failed. A full MSBuild binary log is at:" -ForegroundColor Red
    Write-Host "    $binlog" -ForegroundColor Red
    Write-Host "  Open it with https://msbuildlog.com for the exact failing task." -ForegroundColor Red
    exit 1
}

$built = @(Get-ChildItem (Join-Path $installerDir "bin") -Recurse -Filter "AURION-$Version-x64.msi" -ErrorAction SilentlyContinue |
           Sort-Object LastWriteTime -Descending) | Select-Object -First 1
if (-not $built) { throw "Build reported success but no MSI was produced under installer\bin." }

Copy-Item $built.FullName $outputDir -Force
$wixpdb = [IO.Path]::ChangeExtension($built.FullName, ".wixpdb")
if (Test-Path $wixpdb) { Copy-Item $wixpdb $outputDir -Force }
$msi = Get-Item (Join-Path $outputDir $built.Name)

# ---------------------------------------------------------------------------
# 5. Sign (optional but expected for public releases)
# ---------------------------------------------------------------------------
if ($CertThumbprint) {
    Step "Signing"
    $signtool = @(Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
                  Where-Object { $_.FullName -match "x64" } |
                  Sort-Object FullName -Descending) | Select-Object -First 1
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
