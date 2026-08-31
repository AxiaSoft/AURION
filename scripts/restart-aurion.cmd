@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

REM Flush settings before anything is stopped, so a restart never loses
REM dashboard changes (engine writes config + runtime-state + settings-backup).
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach($u in 'http://127.0.0.1:18765/v1/persist','http://127.0.0.1:18765/v1/shutdown'){ try { Invoke-WebRequest -UseBasicParsing -Method POST $u -TimeoutSec 5 | Out-Null } catch {} }" >nul 2>nul

timeout /t 2 /nobreak >nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "$own=@('node','python','pythonw','py'); foreach($p in 8080,18765,18766){ Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if($proc -and ($own -contains $proc.ProcessName.ToLower())){ Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } }" >nul 2>nul

timeout /t 2 /nobreak >nul

call "%~dp0..\start-aurion.cmd"
exit /b 0
