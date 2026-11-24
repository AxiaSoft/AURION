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
REM -Scope engine: the DESK's port is not in this list. Freeing it used
REM to kill the desk as part of restarting the engine, which is how a
REM failure here ended with nothing at all running.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-engine.ps1" -Root "%~dp0.." -Scope engine >>"%~dp0..\data\logs\desk.log" 2>&1
if errorlevel 1 goto :HELD

call "%~dp0..\start-aurion.cmd"
exit /b 0

:HELD
REM The engine would not let go. It used to end here - deliberately
REM starting nothing, so that a restart could not quietly leave the
REM previous build serving behind a desk claiming it had restarted.
REM
REM The reasoning was right and the remedy was wrong. "Nothing runs" is
REM not the safe outcome of a failed restart; it is the worst one. The
REM trader pressed restart, and was left with no desk, no engine and no
REM window - nothing to read the explanation on, and nothing to press.
REM That is the reported "I restart it and the app never comes back".
REM
REM Two things changed so that starting is now safe. The engine claims
REM its port before it starts anything, so a second one cannot take
REM over, cannot touch MetaTrader and exits in milliseconds. And the
REM desk compares the running build against the files on disk, so a
REM survivor from the previous build is reported on screen instead of
REM being hidden. So: start anyway, and leave the explanation where
REM somebody can actually read it.
echo The previous AURION engine could not be stopped - see data\logs\desk.log
echo Starting the desk anyway so the problem can be seen and acted on.
>>"%~dp0..\data\logs\desk.log" echo {"msg":"restart: engine port still held; starting the desk anyway so the state is visible"}
call "%~dp0..\start-aurion.cmd"
exit /b 0
