# AURION Windows bootstrap.
# Downloads and installs Python 3.12 + Node.js LTS if they are missing,
# then pip + npm packages, copies AurionBridge into every local MT5 Experts folder.
#
#   powershell -ExecutionPolicy Bypass -File windows-app\installer\install-windows.ps1
#   powershell -ExecutionPolicy Bypass -File windows-app\installer\install-windows.ps1 -Launch

param(
  [switch]$Launch
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

$env:PYTHONUNBUFFERED = '1'
$env:PIP_REQUIRE_HASHES = '0'
$env:PIP_NO_CACHE_DIR = '1'
$env:NPM_CONFIG_FETCH_RETRIES = '5'

function Write-Step([string]$msg) {
  Write-Host ''
  Write-Host ('=== {0} ===' -f $msg) -ForegroundColor Cyan
}

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $bits = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\Scripts'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Launcher'),
    (Join-Path $env:ProgramFiles 'nodejs'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs')
  )
  if ($pf86) { $bits += (Join-Path $pf86 'nodejs') }
  $env:Path = (@($machine, $user) + $bits) -join ';'
}

function Get-NodeExe {
  Refresh-Path
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $cands = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  if ($pf86) { $cands += (Join-Path $pf86 'nodejs\node.exe') }
  foreach ($c in $cands) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

function Test-Py312 {
  try {
    $out = & py -3.12 -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and ([string]$out).Trim() -eq '3.12') { return $true }
  } catch { }
  return $false
}

function Test-Node {
  $exe = Get-NodeExe
  if (-not $exe) { return $false }
  try {
    $v = & $exe -p "process.versions.node.split('.')[0]" 2>$null
    $n = [int]([string]$v).Trim()
    if ($n -ge 18 -and $n -le 30) {
      $dir = Split-Path -Parent $exe
      if ($env:Path -notlike ('*{0}*' -f $dir)) {
        $env:Path = ($dir + ';' + $env:Path)
      }
      return $true
    }
    Write-Host ('  Found Node major {0} at {1} (need 18+).' -f $v, $exe) -ForegroundColor Yellow
  } catch { }
  return $false
}

function Install-WithWinget([string]$id) {
  $wg = Get-Command winget -ErrorAction SilentlyContinue
  if (-not $wg) { return $false }
  Write-Host ('winget install {0} ...' -f $id)
  & winget install -e --id $id --accept-package-agreements --accept-source-agreements --disable-interactivity
  return ($LASTEXITCODE -eq 0)
}

function Test-MsiFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $len = (Get-Item -LiteralPath $path).Length
  if ($len -lt 8MB) {
    Write-Host ('  {0} is too small ({1} bytes) - not a real MSI.' -f $path, $len) -ForegroundColor Yellow
    return $false
  }
  $fs = [IO.File]::OpenRead($path)
  try {
    $b = New-Object byte[] 8
    [void]$fs.Read($b, 0, 8)
  } finally { $fs.Close() }
  $ok = ($b[0] -eq 0xD0 -and $b[1] -eq 0xCF -and $b[2] -eq 0x11 -and $b[3] -eq 0xE0)
  if (-not $ok) {
    Write-Host ('  {0} is not an MSI (probably an HTML error page).' -f $path) -ForegroundColor Yellow
  }
  return $ok
}

function Download-File([string]$url, [string]$dest) {
  Write-Host ('Downloading {0}' -f $url)
  $tmp = $dest + '.part'
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
  $ok = $false
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & curl.exe -L --fail --retry 3 --retry-delay 2 --connect-timeout 20 -o $tmp $url
    if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $tmp)) { $ok = $true }
  }
  if (-not $ok) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    if (Test-Path -LiteralPath $tmp) { $ok = $true }
  }
  if (-not $ok) { throw ('Download failed: {0}' -f $url) }
  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
  Move-Item -LiteralPath $tmp -Destination $dest -Force
}

function Install-Python312 {
  if (Test-Py312) {
    Write-Host 'Python 3.12 already present.'
    return
  }
  Write-Step 'Installing Python 3.12'
  if (Install-WithWinget 'Python.Python.3.12') {
    Refresh-Path
    if (Test-Py312) { return }
  }
  $cache = Join-Path $Root 'data\cache'
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $exe = Join-Path $cache 'python-3.12.10-amd64.exe'
  if (-not (Test-Path $exe)) {
    Download-File 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe' $exe
  }
  Write-Host 'Running Python 3.12 silent installer (PrependPath + py launcher)...'
  $p = Start-Process -FilePath $exe -ArgumentList @('/quiet','InstallAllUsers=0','PrependPath=1','Include_launcher=1','Include_pip=1','Include_test=0','SimpleInstall=1') -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
    throw ('Python 3.12 installer failed with exit {0}' -f $p.ExitCode)
  }
  Refresh-Path
  if (-not (Test-Py312)) {
    throw 'Python 3.12 installed but py -3.12 is still not on PATH. Sign out/in or reboot, then run this installer again.'
  }
}

function Install-NodeFromMsi {
  $cache = Join-Path $Root 'data\cache'
  New-Item -ItemType Directory -Force -Path $cache | Out-Null
  $logDir = Join-Path $Root 'data\logs'
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null

  # 22 LTS first: scripts\fix-npm.ps1 documents Node 26 failing TLS mid-tarball
  # during npm install.  Node 18+ (including 26) is still accepted if present.
  $urls = @(
    'https://nodejs.org/dist/v22.22.3/node-v22.22.3-x64.msi',
    'https://nodejs.org/dist/v26.8.1/node-v26.8.1-x64.msi',
    'https://nodejs.org/dist/v26.5.1/node-v26.5.1-x64.msi',
    'https://npmmirror.com/mirrors/node/v22.22.3/node-v22.22.3-x64.msi'
  )

  foreach ($url in $urls) {
    $name = Split-Path -Leaf $url
    $msi = Join-Path $cache $name
    if (Test-Path -LiteralPath $msi) {
      if (-not (Test-MsiFile $msi)) {
        Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
      }
    }
    if (-not (Test-Path -LiteralPath $msi)) {
      try { Download-File $url $msi } catch {
        Write-Host ('  download failed: {0}' -f $url) -ForegroundColor Yellow
        continue
      }
    }
    if (-not (Test-MsiFile $msi)) {
      Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
      continue
    }
    $log = Join-Path $logDir 'node-msi.log'
    Write-Host ('Running {0} ...' -f $name)
    $p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $msi, '/qn', '/norestart', '/L*v', $log) -Wait -PassThru
    if ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010) {
      Refresh-Path
      if (Test-Node) { return $true }
    }
    Write-Host ('  msiexec exit {0} (1620 = file is not a valid MSI). Log: {1}' -f $p.ExitCode, $log) -ForegroundColor Yellow
    if ($p.ExitCode -eq 1620) {
      Remove-Item -LiteralPath $msi -Force -ErrorAction SilentlyContinue
    }
  }
  return $false
}

function Install-NodeLts {
  if (Test-Node) {
    Write-Host ('Node.js {0} already present.' -f (& (Get-NodeExe) -v))
    return
  }
  Write-Step 'Installing Node.js LTS'
  if (Install-WithWinget 'OpenJS.NodeJS.LTS') {
    Refresh-Path
    if (Test-Node) { return }
  }
  if (Install-WithWinget 'OpenJS.NodeJS') {
    Refresh-Path
    if (Test-Node) { return }
  }
  if (Install-NodeFromMsi) { return }
  throw @'
Node.js 18+ was not found (26 is OK).

If msiexec printed 1620, skip the MSI and install Node yourself:
  1. Install any Node 18 or newer (22 LTS or 26) with Add to PATH
  2. Close this window
  3. Double-click install-aurion.cmd

Python must stay 3.12 (py -3.12). Do not use 3.13 or 3.14.
'@
}

function Install-PythonPackages {
  Write-Step 'Python packages (engine)'
  & py -3.12 -m pip install --disable-pip-version-check --upgrade pip
  & py -3.12 -m pip install --disable-pip-version-check --no-cache-dir -r (Join-Path $Root 'engine\requirements.txt')
  if ($LASTEXITCODE -ne 0) { throw 'pip install -r engine\requirements.txt failed' }
  & py -3.12 -m pip install --disable-pip-version-check --no-cache-dir "psycopg[binary]>=3.1"
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'psycopg (PostgreSQL) skipped. SQLite still works.' -ForegroundColor Yellow
  }
  & py -3.12 -m pip install --disable-pip-version-check --no-cache-dir 'MetaTrader5>=5.0.4874'
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'MetaTrader5 package skipped (install later on the MT5 machine).' -ForegroundColor Yellow
  }
  & py -3.12 -c "import numpy, pandas, sklearn, fastapi, uvicorn; print('py-stack', numpy.__version__, 'ok')"
  if ($LASTEXITCODE -ne 0) { throw 'Python stack import failed' }
}

function Install-DeskPackages {
  Write-Step 'Node packages (desk)'
  if (Test-Path (Join-Path $Root 'backend\node_modules\express')) {
    Write-Host 'backend\node_modules already present.'
    return
  }
  $env:NPM_CONFIG_FETCH_RETRIES = '5'
  $env:NPM_CONFIG_FETCH_RETRY_MINTIMEOUT = '20000'
  $env:NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT = '120000'
  Push-Location (Join-Path $Root 'backend')
  try {
    npm install --no-audit --no-fund --no-optional --omit=dev
    if ($LASTEXITCODE -ne 0) {
      Write-Host 'npm failed once (common on Node 26 TLS). Retrying...' -ForegroundColor Yellow
      $env:NODE_OPTIONS = [string]$env:NODE_OPTIONS
      npm install --no-audit --no-fund --no-optional --omit=dev
    }
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed. Run scripts\fix-npm.ps1' }
  } finally {
    Pop-Location
  }
}

function Allow-LanDesk {
  Write-Step 'Windows firewall - allow desk port 8080 on Private networks'
  try {
    $name = 'AURION Desk 8080'
    $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if (-not $existing) {
      New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private,Domain -ErrorAction Stop | Out-Null
      Write-Host '  inbound TCP 8080 allowed (Private/Domain).'
    } else {
      Write-Host '  firewall rule already present.'
    }
  } catch {
    Write-Host '  Could not add the firewall rule (need admin, or add it later). The local desk may stay reachable only on 127.0.0.1.' -ForegroundColor Yellow
  }
}

function Get-LanIPv4 {
  $raw = @()
  try {
    $raw = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -and $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -ExpandProperty IPAddress -Unique)
  } catch { }
  $prefer = @()
  $other = @()
  foreach ($ip in $raw) {
    if ($ip -like '192.168.*') { $prefer += $ip }
    elseif ($ip -like '10.*') { $prefer += $ip }
    else { $other += $ip }
  }
  return @($prefer + $other)
}

function Show-LanHint {
  $ips = Get-LanIPv4
  if ($ips.Count -eq 0) { return }
  Write-Host '  Phone PWA (same Wi-Fi). Prefer 192.168.x.x from ipconfig Wi-Fi adapter:'
  foreach ($ip in $ips) {
    Write-Host ('    http://{0}:8080' -f $ip)
  }
}

function Copy-AurionEa {
  Write-Step 'Copy AurionBridge.mq5 into local MetaTrader Experts'
  $src = Join-Path $Root 'engine\ea\AurionBridge.mq5'
  if (-not (Test-Path $src)) {
    Write-Host ('EA source missing: {0}' -f $src) -ForegroundColor Yellow
    return
  }
  $copied = 0
  if ($env:APPDATA) {
    $mq = Join-Path $env:APPDATA 'MetaQuotes\Terminal'
    if (Test-Path $mq) {
      Get-ChildItem $mq -Directory -ErrorAction SilentlyContinue | ForEach-Object {
        $experts = Join-Path $_.FullName 'MQL5\Experts'
        if (-not (Test-Path $experts)) { return }
        $destDir = Join-Path $experts 'Aurion'
        New-Item -ItemType Directory -Force -Path $destDir | Out-Null
        Copy-Item $src (Join-Path $destDir 'AurionBridge.mq5') -Force
        $alias = Join-Path $Root 'engine\ea\AurionChartAgent.mq5'
        if (Test-Path $alias) { Copy-Item $alias (Join-Path $destDir 'AurionChartAgent.mq5') -Force }
        $copied++
        Write-Host ('  copied -> {0}' -f $destDir)
      }
    }
  }
  if ($copied -eq 0) {
    Write-Host 'No local MT5 Experts folder found yet. After you install MetaTrader, run this installer again or copy engine\ea\AurionBridge.mq5 yourself.' -ForegroundColor Yellow
  }
}

function Ensure-Folders {
  @(
    'data\logs',
    'data\exports',
    'data\uploads',
    'data\archive',
    'data\ea-inbox',
    'data\cache',
    'engine\models'
  ) | ForEach-Object {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $_) | Out-Null
  }
  if ($env:APPDATA) {
    New-Item -ItemType Directory -Force -Path (Join-Path $env:APPDATA 'MetaQuotes\Terminal\Common\Files') -ErrorAction SilentlyContinue | Out-Null
  }
}

Write-Host ''
Write-Host '  AURION Windows installer' -ForegroundColor Green
Write-Host ('  Tree: {0}' -f $Root)
Write-Host ''

if (-not (Test-Path (Join-Path $Root 'backend\src\index.js'))) {
  throw 'This folder is not a complete AURION tree. Copy the full aurion folder to D:\aurion'
}

Ensure-Folders
Install-Python312
Install-NodeLts
Install-PythonPackages
Install-DeskPackages
Copy-AurionEa
Allow-LanDesk

Write-Host ''
Write-Host '  Prerequisites are ready.' -ForegroundColor Green
Write-Host '    Python   py -3.12'
try { Write-Host ('    Node     {0}' -f (& (Get-NodeExe) -v)) } catch { }
Write-Host '    Desk     http://127.0.0.1:8080'
Show-LanHint
Write-Host '    Next     double-click start-aurion.cmd'
Write-Host '    Guide    http://127.0.0.1:8080/guide-install.html'
Write-Host ''

if ($Launch) {
  Write-Step 'Starting AURION'
  $starter = Join-Path $Root 'start-aurion.cmd'
  & cmd.exe /c $starter
}
