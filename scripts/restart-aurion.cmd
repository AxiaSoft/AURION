@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

REM Flush settings before anything is stopped, so a restart never loses
REM dashboard changes (engine writes config + runtime-state + settings-backup).
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach($u in 'http://127.0.0.1:18765/v1/persist','http://127.0.0.1:18765/v1/shutdown'){ try { Invoke-WebRequest -UseBasicParsing -Method POST $u -TimeoutSec 5 | Out-Null } catch {} }" >nul 2>nul

timeout /t 2 /nobreak >nul

REM Stop, and WAIT until the ports are genuinely free.
REM
REM This used to be a best-effort kill followed by a flat two-second
REM sleep. When the kill did not take - an engine owned by another
REM account, running elevated, or simply slower than two seconds - the
REM launcher below started a new engine that could not bind the port
REM and exited, while the old one carried on answering. The desk then
REM reported "Engine running <old> - files on disk <new>" after every
REM restart AND after every Repair install, because both ran this same
REM line. Only rebooting Windows cleared it.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-engine.ps1" -Root "%~dp0.." >>"%~dp0..\data\logs\desk.log" 2>&1
if errorlevel 1 goto :HELD

call "%~dp0..\start-aurion.cmd"
exit /b 0

:HELD
REM Deliberately does NOT start anything. A restart that cannot replace
REM the engine must fail visibly rather than leave the previous build
REM running behind a desk that says it restarted.
echo The previous AURION engine could not be stopped - see data\logs\desk.log
exit /b 1
