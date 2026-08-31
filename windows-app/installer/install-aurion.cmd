@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo   AURION first-time installer
echo   Downloads Python 3.12 + Node.js LTS if they are missing,
echo   then engine packages, desk packages, and copies AurionBridge.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo   Install failed. Read the lines above.
  echo   Guide: apps\web\guide-install.html
  echo.
  pause
  exit /b %ERR%
)

echo.
echo   Install finished. Starting the desk...
echo.
call "%~dp0..\..\start-aurion.cmd"
exit /b %ERRORLEVEL%
