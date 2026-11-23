@echo off
REM ---------------------------------------------------------------------------
REM  Which Python and which Node does THIS installation use?
REM
REM  One answer, in one place, because three callers used to answer it
REM  three different ways and only one of them was right.
REM
REM  Reported from the field: after an update the engine would not come
REM  back, and start-engine.cmd could not start it either - on a machine
REM  where the product itself was fine. The reason was not the engine.
REM  start-engine.cmd ran, and only ever ran:
REM
REM      py -3.12 engine\main.py ...
REM
REM  AURION does not necessarily have a `py` launcher to call. Setup
REM  unpacks a private interpreter into runtime\python and writes its
REM  absolute path into data\runtime.env, and both start-aurion.cmd and
REM  the desk's engine supervisor look there FIRST. So on a machine with
REM  no system-wide Python 3.12 - which is the normal outcome of a clean
REM  install - the repair script a user is told to run was the one thing
REM  guaranteed to fail, and it failed with a message about Python that
REM  made it look like the installation was broken.
REM
REM  Called, not executed: this file deliberately does NOT use setlocal,
REM  so the variables it sets survive into the caller.
REM
REM      call "%~dp0scripts\find-runtime.cmd"
REM      if not defined AURION_PYCMD  ... no interpreter
REM      if not defined AURION_NODECMD ... no node
REM
REM  Both are set to a full command, already quoted where it needs to be,
REM  so they are used as:  %AURION_PYCMD% engine\main.py ...
REM
REM  AURION_PYFROM / AURION_NODEFROM name where the answer came from, so
REM  a failing machine can say which interpreter it actually used instead
REM  of leaving support to guess.
REM ---------------------------------------------------------------------------

set "AURION_PYCMD="
set "AURION_NODECMD="
set "AURION_PYFROM="
set "AURION_NODEFROM="

REM The tree root is the parent of this script's folder.
set "AURION_ROOT=%~dp0.."
pushd "%AURION_ROOT%" >nul 2>nul
set "AURION_ROOT=%CD%"
popd >nul 2>nul

call :READ_RUNTIME_ENV

REM -------------------------------------------------------------- python
REM AURION's own interpreter first - before runtime.env, and before the
REM machine's.  The engine is pinned to a NumPy built for CPython
REM 3.9-3.12, so following whatever Python the user upgraded to is how a
REM working installation breaks itself.
if exist "%AURION_ROOT%\runtime\python\python.exe" (
  set "AURION_PYCMD="%AURION_ROOT%\runtime\python\python.exe""
  set "AURION_PYFROM=runtime\python"
)
if defined AURION_PYCMD goto :NODE

REM What setup recorded - unless it is the Microsoft Store alias.
REM %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe is not an interpreter:
REM it is an app execution alias that resolves only inside an interactive
REM session belonging to the user who installed it, and started detached
REM it exits with no output and no log.
if defined AURION_ENV_PY (
  set "AURION_ENV_PY_CLEAN=%AURION_ENV_PY:WindowsApps=%"
)
if defined AURION_ENV_PY if "%AURION_ENV_PY_CLEAN%"=="%AURION_ENV_PY%" if exist "%AURION_ENV_PY%" (
  set "AURION_PYCMD="%AURION_ENV_PY%""
  set "AURION_PYFROM=data\runtime.env"
)
if defined AURION_PYCMD goto :NODE

REM The py launcher, newest supported version first.
where py >nul 2>nul
if errorlevel 1 goto :PY_PLAIN
for %%V in (3.12 3.11 3.10) do (
  if not defined AURION_PYCMD (
    py -%%V -c "import sys" >nul 2>nul
    if not errorlevel 1 (
      set "AURION_PYCMD=py -%%V"
      set "AURION_PYFROM=py launcher"
    )
  )
)
:PY_PLAIN
if defined AURION_PYCMD goto :NODE
REM Plain `python`, but only when it is a version the engine can run on.
python -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)" >nul 2>nul
if not errorlevel 1 (
  set "AURION_PYCMD=python"
  set "AURION_PYFROM=PATH"
)

:NODE
REM ---------------------------------------------------------------- node
if exist "%AURION_ROOT%\runtime\node\node.exe" (
  set "AURION_NODECMD="%AURION_ROOT%\runtime\node\node.exe""
  set "AURION_NODEFROM=runtime\node"
)
if defined AURION_NODECMD goto :DONE
if defined AURION_ENV_NODE if exist "%AURION_ENV_NODE%" (
  set "AURION_NODECMD="%AURION_ENV_NODE%""
  set "AURION_NODEFROM=data\runtime.env"
)
if defined AURION_NODECMD goto :DONE
where node >nul 2>nul
if not errorlevel 1 (
  set "AURION_NODECMD=node"
  set "AURION_NODEFROM=PATH"
)
if defined AURION_NODECMD goto :DONE
if exist "%ProgramFiles%\nodejs\node.exe" (
  set "AURION_NODECMD="%ProgramFiles%\nodejs\node.exe""
  set "AURION_NODEFROM=Program Files"
)
if defined AURION_NODECMD goto :DONE
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" (
  set "AURION_NODECMD="%LOCALAPPDATA%\Programs\nodejs\node.exe""
  set "AURION_NODEFROM=LOCALAPPDATA"
)

:DONE
exit /b 0

:READ_RUNTIME_ENV
REM data\runtime.env is written by setup: PYTHON=<abs path>, NODE=<abs path>.
set "AURION_ENV_PY="
set "AURION_ENV_NODE="
if not exist "%AURION_ROOT%\data\runtime.env" goto :eof
for /f "usebackq tokens=1,* delims==" %%A in ("%AURION_ROOT%\data\runtime.env") do (
  if /i "%%A"=="PYTHON" set "AURION_ENV_PY=%%B"
  if /i "%%A"=="NODE"   set "AURION_ENV_NODE=%%B"
)
goto :eof
