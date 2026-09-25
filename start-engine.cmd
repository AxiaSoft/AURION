@echo off
setlocal
cd /d "%~dp0"
echo Starting AURION engine with Python 3.12
py -3.12 engine\main.py --host 127.0.0.1 --port 18765
if errorlevel 1 (
  echo.
  echo Engine failed. Use Python 3.12:
  echo   py -3.12 engine\main.py --host 127.0.0.1 --port 18765
  pause
)
