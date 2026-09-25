@echo off
REM Local-only key minting (owner machine only) - Windows CMD wrapper.
REM Lives in admin\ ; the AURION tree root is one level up.
REM Fixes ModuleNotFoundError by setting PYTHONPATH to <root>\engine
REM Usage:
REM   admin\mint-key.cmd developer "admin-owner"
REM   admin\mint-key.cmd m1 "client@example.com"
REM   set AURION_KEY_PRIVATE_HEX=9090ebd8... & admin\mint-key.cmd developer "admin-owner"

setlocal
set "HERE=%~dp0"
set "ROOT=%~dp0..\"
set "ENGINE=%ROOT%engine"
set "PYTHONPATH=%ENGINE%;%PYTHONPATH%"

REM Support both env names - if AURION_KEY_PRIVATE_HEX set, copy to AXIASOFT_KEY_PRIVATE
if not "%AURION_KEY_PRIVATE_HEX%"=="" (
  if "%AXIASOFT_KEY_PRIVATE%"=="" set "AXIASOFT_KEY_PRIVATE=%AURION_KEY_PRIVATE_HEX%"
)
if not "%AXIASOFT_KEY_PRIVATE%"=="" (
  if "%AURION_KEY_PRIVATE_HEX%"=="" set "AURION_KEY_PRIVATE_HEX=%AXIASOFT_KEY_PRIVATE%"
)

if "%~1"=="" (
  echo Usage: admin\mint-key.cmd ^<plan^> [note]
  echo Plans: m1, m3, m6, y1, developer
  echo Example: admin\mint-key.cmd developer "admin-owner"
  echo Example: admin\mint-key.cmd m1 "client@example.com"
  echo.
  echo Set private key first:
  echo   set AURION_KEY_PRIVATE_HEX=your-64-hex-ed25519-seed
  exit /b 2
)

REM AURION runs on CPython 3.12 (engine\main.py refuses 3.13+ on Windows).
REM Prefer the py launcher, fall back to whatever "python" resolves to.
set "PYCMD="
where py >nul 2>nul
if not errorlevel 1 (
  py -3.12 -c "import sys" >nul 2>nul
  if not errorlevel 1 set "PYCMD=py -3.12"
)
if not defined PYCMD set "PYCMD=python"

%PYCMD% "%HERE%mint_local.py" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
