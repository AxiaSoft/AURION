@echo off
REM AURION Update Server launcher. Lives in admin\ next to update-server\.
REM
REM Do not generate the token inline in an "if not exist (...)" block:
REM cmd.exe expands %VAR% when it parses the block, so a variable set
REM inside it reads back empty. That bug wrote "ADMIN_TOKEN=" into .env
REM and printed a blank token, and the panel then answered 401 to
REM everything. ensure-env.js does it, and repairs a .env already
REM damaged that way.
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo   AURION Update Server
echo   --------------------

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js 18+ is required. Install Node.js and try again.
  pause
  exit /b 1
)

if not exist "update-server\data" mkdir "update-server\data"

set "ADMTOK="
for /f "usebackq delims=" %%T in (`node "update-server\ensure-env.js"`) do set "ADMTOK=%%T"
if not defined ADMTOK (
  echo   Could not prepare update-server\.env.
  pause
  exit /b 1
)

echo   panel   http://127.0.0.1:8898/admin/aurion-update-admin-x9k3
echo   token   !ADMTOK!
echo.
echo   Leave this window open. Close it and updates stop being served.
echo.

cd update-server
if not exist "node_modules\express" (
  echo   Installing update-server packages...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo   npm install failed.
    pause
    exit /b 1
  )
)
node src\index.js
if errorlevel 1 (
  echo.
  echo   The update server stopped with an error. The text above says why.
  pause
)
