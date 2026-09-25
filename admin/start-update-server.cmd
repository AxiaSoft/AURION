@echo off
REM AURION Update Server launcher. Lives in admin\ next to update-server\.
setlocal EnableExtensions
cd /d "%~dp0"

echo Starting AURION Update Server...
if not exist "update-server\data" mkdir "update-server\data"
if not exist "update-server\.env" (
  if exist "update-server\.env.example" (
    echo Copying .env.example to .env - edit ADMIN_TOKEN and ADMIN_PANEL_HASH then run again.
    copy "update-server\.env.example" "update-server\.env" >nul
  ) else (
    echo WARNING: update-server\.env is missing and no .env.example was found.
    echo          The admin API stays disabled until ADMIN_TOKEN is set.
  )
)

cd update-server
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required. Run windows-app\installer\install-aurion.cmd first.
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
