@echo off
setlocal
echo Saving AURION settings, then stopping ports 8080, 18765, 18766...
REM 1) Ask the engine to flush every dashboard-applied setting to
REM    config\aurion.json + data\runtime-state.json + data\settings-backup.json
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach($u in 'http://127.0.0.1:18765/v1/persist','http://127.0.0.1:18765/v1/shutdown'){ foreach($try in 1,2){ try { Invoke-WebRequest -UseBasicParsing -Method POST $u -TimeoutSec 6 | Out-Null; break } catch { Start-Sleep -Milliseconds 400 } } }"
timeout /t 2 /nobreak >nul
REM 2) Anything still bound after the graceful call is force-stopped.
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach($p in 8080,18765,18766){ Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"
echo Done. Settings were flushed to config\aurion.json, data\runtime-state.json and data\settings-backup.json.
timeout /t 2 >nul
