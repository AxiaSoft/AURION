@echo off
REM Point this build at your servers, before the MSI is made.
REM Wrapper around scripts\set-endpoints.mjs so nobody has to remember
REM the node incantation. All arguments are passed straight through.
REM
REM   scripts\set-endpoints.cmd --show
REM   scripts\set-endpoints.cmd --updates https://updates.example.com ^
REM                             --store   https://keys.example.com ^
REM                             --telegram 7123456789:AA...
setlocal EnableExtensions
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required.
  pause
  exit /b 1
)
node scripts\set-endpoints.mjs %*
if errorlevel 1 pause
