# Start AURION on Windows. Requires CPython 3.10, 3.11 or 3.12 (not 3.13/3.14).
#   powershell -ExecutionPolicy Bypass -File D:\aurion\scripts\start.ps1

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$env:PYTHONUNBUFFERED = "1"
$env:AURION_HOST = "0.0.0.0"
$env:AURION_PORT = "8080"
$env:PIP_REQUIRE_HASHES = "0"
$env:PIP_NO_CACHE_DIR = "1"

function Get-PyExe {
  param([string]$Spec)
  try {
    $out = & py "-$Spec" -c "import sys; print(sys.executable)" 2>$null
    if ($LASTEXITCODE -eq 0 -and $out) { return ([string]$out).Trim() }
  } catch { }
  return $null
}

function Get-AurionPython {
  if ($env:AURION_PYTHON -and (Test-Path -LiteralPath $env:AURION_PYTHON)) {
    return $env:AURION_PYTHON
  }
  foreach ($ver in @("3.12", "3.11", "3.10")) {
    $exe = Get-PyExe $ver
    if ($exe) { return $exe }
  }
  $fallback = Get-Command python -ErrorAction SilentlyContinue
  if ($fallback) { return $fallback.Source }
  return $null
}

function Assert-Ok {
  param([string]$What)
  if ($LASTEXITCODE -ne 0) { throw $What }
}

$Py = Get-AurionPython
if (-not $Py) {
  Write-Host "AURION needs Python 3.10 / 3.11 / 3.12."
  exit 1
}

$verLine = & $Py -c "import sys; print(str(sys.version_info[0]) + '.' + str(sys.version_info[1]))"
$verLine = ([string]$verLine).Trim()
$parts = $verLine.Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
Write-Host "AURION using $Py  (Python $verLine)"

if ($major -ne 3 -or $minor -lt 10 -or $minor -gt 12) {
  Write-Host "This interpreter is Python $verLine. Use 3.12."
  exit 1
}

Write-Host "AURION: checking NumPy..."
$npOut = & $Py -c "import numpy; print(numpy.__version__)" 2>&1 | Out-String
$npBad = ($LASTEXITCODE -ne 0) -or ($npOut -match "X86_V2|baseline optimizations") -or ($npOut -notmatch "1\.26\.")
if ($npBad) {
  Write-Host "Installing numpy==1.26.4 (ignore pip cache / hash leftovers)..."
  & $Py -m pip install --disable-pip-version-check --no-cache-dir --upgrade pip
  & $Py -m pip cache purge
  & $Py -m pip install --disable-pip-version-check --no-cache-dir --no-deps --only-binary=:all: numpy==1.26.4
  Assert-Ok "numpy wheel install failed"
}

Write-Host "AURION: installing engine packages..."
& $Py -m pip install --disable-pip-version-check --no-cache-dir -r (Join-Path $Root "engine\requirements.txt")
Assert-Ok "pip install -r engine\requirements.txt failed"
& $Py -m pip install --disable-pip-version-check --no-cache-dir "MetaTrader5>=5.0.4874"
if ($LASTEXITCODE -ne 0) {
  Write-Host "MetaTrader5 package skipped (install it later on the MT5 machine)."
}

& $Py -c "import numpy, pandas, sklearn, fastapi, uvicorn; print('py-stack', numpy.__version__, 'ok')"
Assert-Ok "Python stack import failed"

if (-not (Test-Path (Join-Path $Root "backend\node_modules\express"))) {
  Write-Host "AURION: installing desk packages..."
  Push-Location (Join-Path $Root "backend")
  npm install --no-audit --no-fund --no-optional --omit=dev
  $npmOk = $LASTEXITCODE
  Pop-Location
  if ($npmOk -ne 0) {
    throw "npm install failed. Run: powershell -ExecutionPolicy Bypass -File .\scripts\fix-npm.ps1"
  }
}

New-Item -ItemType Directory -Force -Path data\exports, data\uploads, data\archive, engine\models | Out-Null

Get-NetTCPConnection -LocalPort 18765,8080 -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

New-Item -ItemType Directory -Force -Path (Join-Path $Root "data\logs") | Out-Null
$vbs = Join-Path $Root "scripts\hidden.vbs"
$engineLog = Join-Path $Root "data\logs\engine.log"
$deskLog = Join-Path $Root "data\logs\desk.log"
& cscript //nologo $vbs $Root $engineLog "`"$Py`"" "engine\main.py" "--host" "127.0.0.1" "--port" "18765"
Start-Sleep -Seconds 3
& cscript //nologo $vbs (Join-Path $Root "backend") $deskLog "node" "src\index.js"
Start-Sleep -Seconds 2

try {
  $h = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/health" -TimeoutSec 4
  Write-Host ("health backend={0} engine={1}" -f $h.backend, $h.engine)
} catch {
  Write-Host "Desk did not answer yet. Open the minimized python/node windows for the real error."
}

Start-Process "http://127.0.0.1:8080"
Write-Host "AURION desk  http://127.0.0.1:8080"
Write-Host "Engine       http://127.0.0.1:18765"
