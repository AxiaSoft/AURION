@echo off
REM Local-only key minting (owner machine only) - Windows CMD wrapper
REM Fixes ModuleNotFoundError by setting PYTHONPATH to engine\
REM Usage:
REM   mint-key.cmd developer "admin-owner"
REM   mint-key.cmd m1 "client@example.com"
REM   set AURION_KEY_PRIVATE_HEX=9090ebd8... & mint-key.cmd developer "admin-owner"

setlocal
set "ROOT=%~dp0"
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
  echo Usage: mint-key.cmd ^<plan^> [note]
  echo Plans: m1, m3, m6, y1, developer
  echo Example: mint-key.cmd developer "admin-owner"
  echo Example: mint-key.cmd m1 "client@example.com"
  echo.
  echo Set private key first:
  echo   set AURION_KEY_PRIVATE_HEX=9090ebd82348b326eb891e496f2f5c1746a53243625237411835a810686826dc
  exit /b 2
)

python "%ROOT%scripts\mint_local.py" %*
endlocal
