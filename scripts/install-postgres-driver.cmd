@echo off
cd /d "%~dp0.."
echo Installing PostgreSQL driver for AURION (psycopg)...
py -3.12 -m pip install --disable-pip-version-check "psycopg[binary]>=3.1"
if errorlevel 1 (
  echo FAILED. SQLite still works.
  pause
  exit /b 1
)
echo OK. Set the URL in Settings - Database, then restart AURION.
pause
