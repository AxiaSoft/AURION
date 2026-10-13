@echo off
REM AURION admin panel — one window for updates, Telegram and licences.
REM
REM Replaces start-telegram-panel.cmd and the separate update panel URL.
REM The update server still runs on its own (start-update-server.cmd);
REM this proxies to it, because it owns release storage and uploads and
REM two programs writing one data directory is not a design.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required.
  pause
  exit /b 1
)

REM The licence tab needs the signing seed in this process. It is never
REM written to disk by the panel. Generate one once: python admin\new-seed.py
if "%AURION_KEY_PRIVATE_HEX%"=="" (
  echo.
  echo   AURION_KEY_PRIVATE_HEX is not set, so the Licences tab cannot mint.
  echo   Generate a seed once:   python admin\new-seed.py
  echo   Then, before running this:   set AURION_KEY_PRIVATE_HEX=^<seed^>
  echo.
)

REM The Updates tab proxies to the update server with its admin token.
if "%AURION_UPDATE_TOKEN%"=="" (
  echo   AURION_UPDATE_TOKEN is not set — the Updates tab will say so.
  echo   It is the ADMIN_TOKEN from update-server\.env.
  echo.
)

node panel\server.js
