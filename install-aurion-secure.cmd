@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo   AURION Secure Installer - Graphical
echo   This will download prerequisites securely with TLS verification
echo.

REM Check if PowerShell GUI is available
powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms" >nul 2>nul
if errorlevel 1 (
  echo GUI not available, using console installer...
  call "%~dp0install-aurion.cmd"
  exit /b %ERRORLEVEL%
)

echo Launching graphical installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows-gui.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo   GUI installer failed, trying console installer...
  call "%~dp0install-aurion.cmd"
  exit /b %ERRORLEVEL%
)

echo.
echo   Secure install finished. Starting AURION...
echo.
call "%~dp0start-aurion.cmd"
exit /b %ERRORLEVEL%
