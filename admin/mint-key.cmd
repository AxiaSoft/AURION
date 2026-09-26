@echo off
REM ---------------------------------------------------------------------------
REM  AURION - local key minting (owner machine only), CMD wrapper.
REM
REM  Everything lives in mint-key.ps1: it prompts for the plan, the note and the
REM  private seed when they are not supplied, and it verifies the seed against
REM  this build's public key before minting anything. Keeping one implementation
REM  means the two entry points can never drift apart.
REM
REM      admin\mint-key.cmd
REM      admin\mint-key.cmd developer "admin-owner"
REM      admin\mint-key.cmd m1 "client@example.com"
REM ---------------------------------------------------------------------------
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0mint-key.ps1" %*
set "RC=%ERRORLEVEL%"
endlocal & exit /b %RC%
