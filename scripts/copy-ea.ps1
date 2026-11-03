# Copy the AURION experts into every local MetaTrader 5 Experts\Aurion folder.
#
# This runs on every start, and again right after an update that changed the
# experts. It is the only half of "update everything together" that software
# can do on its own: the files land next to the terminal, but only the person
# at MetaTrader can press F7 and re-attach the expert to the chart.
#
# So it also leaves a receipt in data\ea-install.json - which version was
# copied, when, and into which terminals - and the desk reads that back on
# the Expert Advisors card. Without the receipt the user has no way to tell
# "the new file is waiting for you" from "nothing happened".
$Root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $Root "engine\ea\AurionBridge.mq5"
if (-not (Test-Path $src)) { exit 0 }
if (-not $env:APPDATA) { exit 0 }
$mq = Join-Path $env:APPDATA "MetaQuotes\Terminal"
if (-not (Test-Path $mq)) { exit 0 }

# The version is read out of the file itself, never typed here: a number
# repeated in a second place is a number that goes stale.
$version = ""
$match = Select-String -Path $src -Pattern '#property\s+version\s+"([0-9][0-9.]*)"' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($match) { $version = $match.Matches[0].Groups[1].Value }

$copied = New-Object System.Collections.ArrayList
$alias = Join-Path $Root "engine\ea\AurionChartAgent.mq5"

Get-ChildItem $mq -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $experts = Join-Path $_.FullName "MQL5\Experts"
  if (-not (Test-Path $experts)) { return }
  $destDir = Join-Path $experts "Aurion"
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  Copy-Item $src (Join-Path $destDir "AurionBridge.mq5") -Force
  if (Test-Path $alias) { Copy-Item $alias (Join-Path $destDir "AurionChartAgent.mq5") -Force }
  [void]$copied.Add($destDir)
}

try {
  $dataDir = Join-Path $Root "data"
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $receipt = [ordered]@{
    version = $version
    at      = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    folders = @($copied)
  }
  $receipt | ConvertTo-Json -Depth 3 | Set-Content -Path (Join-Path $dataDir "ea-install.json") -Encoding UTF8
} catch { }
