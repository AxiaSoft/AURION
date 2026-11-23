@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM ---------------------------------------------------------------------------
REM  Start the engine in THIS window, so whatever goes wrong is readable.
REM
REM  This script used to be two lines:
REM
REM      py -3.12 engine\main.py --host 127.0.0.1 --port 18765
REM      if errorlevel 1 echo Engine failed. Use Python 3.12:
REM
REM  Both of them were wrong on a normally installed machine. Setup
REM  unpacks a private interpreter into runtime\python and records it in
REM  data\runtime.env; start-aurion.cmd and the desk's supervisor both
REM  look there first, and neither needs a `py` launcher to exist. This
REM  script did, so on a clean install it failed every time - and then
REM  blamed Python, which is how "the engine will not start" turned into
REM  a reinstall that changed nothing.
REM
REM  Now it asks the same question the same way (scripts\find-runtime.cmd)
REM  and, before starting anything, says whether the port is already held
REM  - because an engine that cannot bind exits quietly, and the symptom
REM  of that is indistinguishable from "it will not start".
REM ---------------------------------------------------------------------------

if not exist "engine\main.py" (
  echo AURION: engine\main.py is missing.
  echo This folder is not a complete AURION tree.
  pause
  exit /b 1
)

set "AURION_PORT=18765"

call "%~dp0scripts\find-runtime.cmd"

if not defined AURION_PYCMD goto :NOPY

echo.
echo   Python  %AURION_PYCMD%   (found via %AURION_PYFROM%)
echo   Engine  http://127.0.0.1:%AURION_PORT%
echo.

REM Is somebody already on the port? uvicorn's own failure for this is one
REM line deep in a traceback, and a user reads it as a crash.
for /f "tokens=5" %%P in ('netstat -ano -p tcp ^| findstr /r /c:"LISTENING" ^| findstr /c:":%AURION_PORT% "') do set "AURION_HOLDER=%%P"
if defined AURION_HOLDER goto :HELD

REM The engine's libraries, named one by one rather than as a single
REM "install the requirements" - the usual case after an interrupted
REM update is that exactly one of them is half-written.
%AURION_PYCMD% -c "import fastapi,numpy,sklearn" >nul 2>nul
if errorlevel 1 goto :NOLIBS

%AURION_PYCMD% engine\main.py --host 127.0.0.1 --port %AURION_PORT%
set "RC=%errorlevel%"
if not "%RC%"=="0" goto :FAILED
exit /b 0

:NOPY
echo.
echo   No usable Python was found for AURION.
echo.
echo   It looks for, in order:
echo     runtime\python\python.exe     (installed by setup)
echo     the PYTHON= line in data\runtime.env
echo     py -3.12 / -3.11 / -3.10
echo     python  (only if it is 3.10, 3.11 or 3.12)
echo.
echo   Install the runtime without touching the rest of the machine:
echo     powershell -ExecutionPolicy Bypass -File scripts\provision.ps1
echo.
pause
exit /b 1

:HELD
echo.
echo   Port %AURION_PORT% is already in use by process %AURION_HOLDER%.
echo   A second engine cannot bind it, so starting one here would exit
echo   immediately and the old process would keep answering.
echo.
echo   Who owns it:
tasklist /fi "pid eq %AURION_HOLDER%" 2>nul | findstr /v "^$"
echo.
echo   Stop it, and wait for the port to actually go quiet:
echo     powershell -ExecutionPolicy Bypass -File scripts\stop-engine.ps1
echo.
pause
exit /b 1

:NOLIBS
echo.
echo   The engine's Python libraries are not all installed.
for /f "delims=" %%M in ('%AURION_PYCMD% -c "import importlib.util as u; print(', '.join(m for m in ('fastapi','numpy','sklearn') if u.find_spec(m) is None))" 2^>nul') do echo     missing: %%M
echo.
echo   Repair them:
echo     powershell -ExecutionPolicy Bypass -File scripts\provision.ps1
echo     powershell -ExecutionPolicy Bypass -File scripts\fix-numpy.ps1
echo.
pause
exit /b 1

:FAILED
echo.
echo   The engine stopped with code %RC%. The reason is above, and in:
echo     data\logs\engine.log
echo.
echo   A full read of this machine, which changes nothing:
echo     powershell -ExecutionPolicy Bypass -File scripts\engine-doctor.ps1
echo.
pause
exit /b %RC%
