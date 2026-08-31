@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo   AURION starting engine + desk in the background
echo   No extra terminal windows. Logs live inside the dashboard.
echo.

if not exist "data\logs" mkdir "data\logs"
if not exist "data\exports" mkdir "data\exports"
if not exist "data\uploads" mkdir "data\uploads"
if not exist "data\archive" mkdir "data\archive"
if not exist "data\ea-inbox" mkdir "data\ea-inbox"
if not exist "engine\models" mkdir "engine\models"
if defined APPDATA if not exist "%APPDATA%\MetaQuotes\Terminal\Common\Files" mkdir "%APPDATA%\MetaQuotes\Terminal\Common\Files" 2>nul

if not exist "backend\src\index.js" goto :NOTREE

where py >nul 2>nul
if errorlevel 1 goto :NEEDINSTALL
py -3.12 -c "import sys" >nul 2>nul
if errorlevel 1 goto :NEEDINSTALL
where node >nul 2>nul
if errorlevel 1 goto :NEEDINSTALL
py -3.12 -c "import fastapi,numpy,sklearn" >nul 2>nul
if errorlevel 1 goto :NEEDINSTALL
if not exist "backend\node_modules\express" goto :NEEDINSTALL
goto :LAUNCH

:NEEDINSTALL
echo Prerequisites missing or incomplete. Running the installer...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-windows.ps1"
if errorlevel 1 goto :INSTALLFAIL
call :REFRESHPATH
goto :LAUNCH

:INSTALLFAIL
echo.
echo Installer failed. Double-click install-aurion.cmd and read the log.
echo Guide: apps\web\guide-install.html
echo.
pause
exit /b 1

:NOTREE
echo backend\src\index.js is missing.
echo This folder is not a complete AURION tree. Copy the full aurion folder to D:\aurion
pause
exit /b 1

:LAUNCH
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\copy-ea.ps1" >nul 2>nul

REM Free AURION ports if a previous hidden process is still bound
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach($p in 8080,18765,18766){ Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }" >nul 2>nul

cscript //nologo "%~dp0scripts\hidden.vbs" "%CD%" "%CD%\data\logs\engine.log" py -3.12 engine\main.py --host 127.0.0.1 --port 18765
timeout /t 3 /nobreak >nul
cscript //nologo "%~dp0scripts\hidden.vbs" "%CD%\backend" "%CD%\data\logs\desk.log" node src\index.js
timeout /t 2 /nobreak >nul

start "" "http://127.0.0.1:8080"

echo.
echo   Desk    http://127.0.0.1:8080
echo   Guide   http://127.0.0.1:8080/guide-install.html
echo   Engine  127.0.0.1:18765
echo   EA      127.0.0.1:18766
echo   Logs    dashboard Terminal tabs: Engine / Desk
echo   Stop    double-click stop-aurion.cmd
echo.
timeout /t 4 >nul
exit /b 0

:REFRESHPATH
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MACHINE_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
if defined MACHINE_PATH if defined USER_PATH set "PATH=%MACHINE_PATH%;%USER_PATH%"
if defined MACHINE_PATH if not defined USER_PATH set "PATH=%MACHINE_PATH%"
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%LOCALAPPDATA%\Programs\Python\Launcher;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\Microsoft VS Code\bin"
goto :eof
