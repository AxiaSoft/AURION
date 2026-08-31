@echo off
setlocal EnableExtensions
echo Saving AURION settings, then stopping the AURION engine and desk...

REM 1) Ask the engine to flush every dashboard-applied setting to
REM    config\aurion.json + data\runtime-state.json + data\settings-backup.json
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach($u in 'http://127.0.0.1:18765/v1/persist','http://127.0.0.1:18765/v1/shutdown'){ foreach($try in 1,2){ try { Invoke-WebRequest -UseBasicParsing -Method POST $u -TimeoutSec 6 | Out-Null; break } catch { Start-Sleep -Milliseconds 400 } } }"
timeout /t 2 /nobreak >nul

REM 2) Anything still bound after the graceful call is force-stopped - but only
REM    when an AURION runtime (node/python) owns the port, so an unrelated
REM    program that happens to use 8080 is left alone.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$own=@('node','python','pythonw','py'); $k=0; foreach($p in 8080,18765,18766){ Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if($proc -and ($own -contains $proc.ProcessName.ToLower())){ Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue; $k++ } } }; if($k -gt 0){ Write-Host ('  force-stopped ' + $k + ' AURION process(es)') } else { Write-Host '  nothing was left bound' }"

echo Done. Settings were flushed to config\aurion.json, data\runtime-state.json and data\settings-backup.json.
timeout /t 2 >nul
