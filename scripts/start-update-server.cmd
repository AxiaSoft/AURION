@echo off
cd /d "%~dp0.."
echo Starting AURION Update Server...
if not exist "update-server\data" mkdir "update-server\data"
if not exist "update-server\.env" (
  echo Copying .env.example to .env
  copy "update-server\.env.example" "update-server\.env"
)
cd update-server
npm install --no-audit --no-fund >nul 2>nul
node src/index.js
