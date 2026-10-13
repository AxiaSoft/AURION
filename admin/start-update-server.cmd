@echo off
REM AURION Update Server launcher. Lives in admin\ next to update-server\.
setlocal EnableExtensions
cd /d "%~dp0"

echo Starting AURION Update Server...
if not exist "update-server\data" mkdir "update-server\data"
REM First run writes a .env with a token already in it.
REM
REM This used to copy .env.example and tell the user to go and edit it.
REM There was no .env.example, so it printed a warning and started
REM anyway: the panel then loaded, every button answered 401, and
REM nothing on screen said a token was needed or where to put one.
REM Generating one is the same work for us and none for them.
if not exist "update-server\.env" (
  for /f %%T in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString(\"N\")"') do set "NEWTOK=%%T"
  >"update-server\.env" echo ADMIN_TOKEN=%NEWTOK%
  >>"update-server\.env" echo ADMIN_PANEL_HASH=aurion-update-admin-x9k3
  >>"update-server\.env" echo PORT=8898
  >>"update-server\.env" echo DATA_DIR=data
  echo.
  echo   Wrote update-server\.env
  echo   Admin token: %NEWTOK%
  echo   Anyone holding it can publish an update to every installed AURION.
  echo.
)

cd update-server
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required. Install Node.js and try again.
  pause
  exit /b 1
)
if not exist "node_modules\express" (
  echo Installing update-server packages...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)
node src\index.js
