@echo off
setlocal
cd /d "%~dp0backend"
if not exist "src\index.js" (
  echo AURION: backend\src\index.js is missing.
  echo You are not in a complete AURION tree.
  pause
  exit /b 1
)
if not exist "node_modules\express" (
  echo Installing desk packages...
  call npm install --no-audit --no-fund --no-optional --omit=dev
  if errorlevel 1 (
    echo npm install failed. See scripts\fix-npm.ps1
    pause
    exit /b 1
  )
)
echo Starting AURION desk on http://127.0.0.1:8080
node src\index.js
