@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM  Start the desk in THIS window.
REM
REM  Same correction as start-engine.cmd: this used to call a bare `node`,
REM  which is only on the PATH when Node was installed machine-wide. A
REM  copy unpacked into runtime\node by setup - and recorded in
REM  data\runtime.env - was invisible to it, so the script reported that
REM  the desk could not start on a machine where start-aurion.cmd starts
REM  it perfectly. One resolver now answers for all of them.
REM ---------------------------------------------------------------------------

if not exist "backend\src\index.js" (
  echo AURION: backend\src\index.js is missing.
  echo You are not in a complete AURION tree.
  pause
  exit /b 1
)

call "%~dp0scripts\find-runtime.cmd"

if not defined AURION_NODECMD goto :NONODE

if not exist "backend\node_modules\express" (
  echo Installing desk packages...
  pushd backend
  call npm install --no-audit --no-fund --no-optional --omit=dev
  set "RC=%errorlevel%"
  popd
  if not "%RC%"=="0" (
    echo npm install failed. See scripts\fix-npm.ps1
    pause
    exit /b 1
  )
)

echo.
echo   Node  %AURION_NODECMD%   (found via %AURION_NODEFROM%)
echo   Desk  http://127.0.0.1:8080
echo.

cd /d "%~dp0backend"
%AURION_NODECMD% src\index.js
exit /b %errorlevel%

:NONODE
echo.
echo   No usable Node was found for AURION.
echo.
echo   It looks for, in order:
echo     runtime\node\node.exe      (installed by setup)
echo     the NODE= line in data\runtime.env
echo     node on the PATH, then Program Files and LOCALAPPDATA
echo.
echo   Install it without touching the rest of the machine:
echo     powershell -ExecutionPolicy Bypass -File scripts\provision.ps1
echo.
pause
exit /b 1
