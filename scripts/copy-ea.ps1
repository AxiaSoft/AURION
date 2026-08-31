# Copy AurionBridge.mq5 into every local MetaTrader 5 Experts\Aurion folder.
$Root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $Root "engine\ea\AurionBridge.mq5"
if (-not (Test-Path $src)) { exit 0 }
if (-not $env:APPDATA) { exit 0 }
$mq = Join-Path $env:APPDATA "MetaQuotes\Terminal"
if (-not (Test-Path $mq)) { exit 0 }
Get-ChildItem $mq -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $experts = Join-Path $_.FullName "MQL5\Experts"
  if (-not (Test-Path $experts)) { return }
  $destDir = Join-Path $experts "Aurion"
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  Copy-Item $src (Join-Path $destDir "AurionBridge.mq5") -Force
  $alias = Join-Path $Root "engine\ea\AurionChartAgent.mq5"
  if (Test-Path $alias) { Copy-Item $alias (Join-Path $destDir "AurionChartAgent.mq5") -Force }
}
