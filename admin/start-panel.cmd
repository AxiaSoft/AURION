@echo off
REM AURION admin panel — one window for updates, Telegram and licences.
REM
REM It no longer asks you to set anything. The update token is read from
REM admin\update-server\.env (written by start-update-server.cmd) and the
REM signing seed from admin\panel\seed.key (written by new-seed.py --save).
REM Setting AURION_UPDATE_TOKEN / AURION_KEY_PRIVATE_HEX still overrides
REM both, for the case where those servers live on another machine.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required.
  pause
  exit /b 1
)

if not exist "update-server\.env" (
  echo.
  echo   admin\update-server\.env does not exist yet, so the Updates tab
  echo   will have no token. Run start-update-server.cmd once - it writes
  echo   the file, and this panel then reads it by itself.
  echo.
)

node panel\server.js
if errorlevel 1 (
  echo.
  echo   The panel stopped with an error. The text above says why.
  pause
)
