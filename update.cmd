@echo off
REM ---------------------------------------------------------------------------
REM  Bring this build tree up to date. One command, and it never refuses.
REM
REM  Written because `git pull` keeps answering:
REM
REM      error: Your local changes to the following files would be
REM      overwritten by merge ... Aborting
REM
REM  which is git doing exactly the right thing for a working copy and
REM  exactly the wrong thing here. This folder is a deployment: nothing
REM  is developed in it, and what git calls "your local changes" is a
REM  file that was pasted in to test a fix, or a line ending nobody
REM  chose. Refusing leaves the machine behind the branch while its
REM  owner believes it is current - and every failure after that is
REM  investigated as a bug in code that was never there.
REM
REM  So this saves whatever is different as a patch under
REM  data\local-changes\ and then takes the branch exactly as GitHub has
REM  it. Nothing is lost; `git apply` puts any of it back.
REM
REM      update.cmd              - update to main
REM      update.cmd some-branch  - update to that branch instead
REM ---------------------------------------------------------------------------

setlocal
cd /d "%~dp0"

set "BRANCH=%~1"
if "%BRANCH%"=="" set "BRANCH=main"

where powershell >nul 2>nul
if errorlevel 1 (
  echo.
  echo   PowerShell was not found on the PATH, so this cannot run.
  echo   Update by hand with:
  echo       git fetch origin %BRANCH%
  echo       git reset --hard FETCH_HEAD
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-build-tree.ps1" -Branch "%BRANCH%"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo   The update did not finish cleanly ^(exit %RC%^).
) else (
  echo   Up to date. Next:  powershell -ExecutionPolicy Bypass -File installer\tools\build-msi.ps1
)
echo.
pause
exit /b %RC%
