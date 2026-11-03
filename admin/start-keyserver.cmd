@echo off
REM AURION key server launcher. Lives in admin\, runs store\keyserver\.
REM
REM This is the thing that makes 1-to-12-month licences work: AURION's
REM desk asks it to activate a key, and it is the only party that can
REM confirm a customer key is genuine. Without it running and reachable,
REM every AXIA- key answers "internet_required".
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0..\store\keyserver"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required. Install it and run this again.
  pause
  exit /b 1
)

REM First run writes a .env, with the secrets already filled in.
REM
REM Everything here has a safe default except the signing seed, which
REM cannot have one: it is the identity of the whole licence system and
REM has to be generated once and kept. admin\new-seed.py makes it.
if not exist ".env" (
  for /f %%T in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString(\"N\")"') do set "TOK=%%T"
  for /f %%J in ('powershell -NoProfile -Command "[guid]::NewGuid().ToString(\"N\")"') do set "JWT=%%J"
  >".env" echo PORT=8899
  >>".env" echo DATA_DIR=data
  >>".env" echo ADMIN_TOKEN=!TOK!
  >>".env" echo ADMIN_PANEL_HASH=aurion-keys-admin
  >>".env" echo JWT_SECRET=!JWT!
  >>".env" echo AURION_KEY_PRIVATE_HEX=
  echo.
  echo   Wrote store\keyserver\.env
  echo   Admin token: !TOK!
  echo.
  echo   AURION_KEY_PRIVATE_HEX is deliberately empty. Generate the
  echo   signing seed once with:
  echo.
  echo       python admin\new-seed.py
  echo.
  echo   then paste the private line into that .env. Until you do, keys
  echo   cannot be minted.
  echo.
)

if not exist "node_modules\express" (
  echo Installing key server packages...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo   Key server starting. Point AURION at it with:
echo       node scripts\set-endpoints.mjs --store https://^<your-address^>
echo   That writes config\aurion.factory.json - the copy the MSI ships.
echo   Editing config\aurion.json only affects THIS machine.
echo.
node src\index.js
