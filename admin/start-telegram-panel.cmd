@echo off
rem AURION - standalone Telegram admin panel (owner only, loopback only)
setlocal
set "ROOT=%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not on PATH. Install it from https://nodejs.org and retry.
  pause
  exit /b 1
)
echo Starting the AURION Telegram admin panel on http://127.0.0.1:8913
echo The bot must be running: start-aurion.cmd first.
node "%ROOT%\admin\telegram-panel\server.js"
pause
