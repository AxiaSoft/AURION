@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo   AURION starting engine + desk in the background
echo   No extra terminal windows. Logs live inside the dashboard.
echo.

if not exist "data\logs" mkdir "data\logs"
if not exist "data\exports" mkdir "data\exports"
if not exist "data\uploads" mkdir "data\uploads"
if not exist "data\archive" mkdir "data\archive"
if not exist "data\ea-inbox" mkdir "data\ea-inbox"
if not exist "engine\models" mkdir "engine\models"
if defined APPDATA if not exist "%APPDATA%\MetaQuotes\Terminal\Common\Files" mkdir "%APPDATA%\MetaQuotes\Terminal\Common\Files" 2>nul

if not exist "backend\src\index.js" goto :NOTREE

REM ---------------------------------------------------------------------------
REM Prerequisites.
REM engine\main.py aborts on CPython 3.13+ and numpy 1.26.4 has no 3.13 wheels,
REM so only 3.10 / 3.11 / 3.12 are accepted - 3.12 first, because that is what
REM the supported baseline.
REM ---------------------------------------------------------------------------
REM Pick up PATH changes a previous setup made. This console inherited its
REM environment when it started, so a Python or Node installed since then is
REM invisible to it - which used to send a perfectly prepared machine round
REM the setup loop and out the other side with "prerequisites missing".
REM :REFRESHPATH existed for this and was never called. It is now.
REM Windows' own tools, by full path.
REM
REM A broken PATH made powershell.exe unfindable and the launcher exited
REM 9009. Nothing here should ever depend on the PATH to locate a program
REM that ships with the operating system.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
set "CSCRIPT=%SystemRoot%\System32\cscript.exe"
if not exist "%CSCRIPT%" set "CSCRIPT=cscript"

call :REFRESHPATH
call :LOADRUNTIME

REM Say what was decided, as it is decided.
REM
REM Everything below can fail without the engine or the desk ever starting,
REM and when that happens neither writes a log - so there was nothing to
REM read afterwards. A failure reported "neither wrote anything", printed
REM data\runtime.env, and left it ambiguous whether that stale file was
REM what had actually been used. These lines are the answer to that: they
REM record the choice at the moment it is made, in the log the desk window
REM already reads back when the other two are empty.
if not exist "data\logs" mkdir "data\logs" >nul 2>nul
set "TRAIL=data\logs\setup.log"
echo.>>"%TRAIL%"
echo [%DATE% %TIME%] launcher starting in "%CD%">>"%TRAIL%"

call :FINDPY
if not defined PYCMD echo [launcher] no usable Python found>>"%TRAIL%"
if not defined PYCMD goto :NEEDINSTALL
echo [launcher] python: %PYCMD%>>"%TRAIL%"

%PYCMD% -c "import fastapi,numpy,sklearn" >nul 2>nul
if errorlevel 1 echo [launcher] that Python cannot import fastapi, numpy and sklearn>>"%TRAIL%"
if errorlevel 1 goto :NEEDINSTALL

call :FINDNODE
if not defined NODECMD echo [launcher] no usable Node found>>"%TRAIL%"
if not defined NODECMD goto :NEEDINSTALL
echo [launcher] node: %NODECMD%>>"%TRAIL%"

if not exist "backend\node_modules\express" echo [launcher] backend\node_modules\express is missing>>"%TRAIL%"
if not exist "backend\node_modules\express" goto :NEEDINSTALL

echo [launcher] prerequisites satisfied, starting>>"%TRAIL%"
goto :LAUNCH

:NEEDINSTALL
REM Prerequisites missing. AURION.exe --setup is the same environment check the
REM installer runs: it names what is missing, where it comes from and how big
REM it is, waits for a yes, then downloads it from the vendor and verifies the
REM signature before running anything. Printing instructions and giving up -
REM which is what this used to do - left the user with an error and homework.
REM
REM Guarded against looping: SETUPDONE is set before the hand-off, so if the
REM check runs and the machine still is not ready, the second pass falls
REM through to the manual instructions instead of starting over.
if defined AURION_SETUP_DONE goto :BYHAND

REM scripts\provision.ps1 is preferred over AURION.exe --setup because it needs
REM nobody to be looking at it. The setup window is the same work with a
REM progress list attached; this runs unattended, which is what a machine
REM being started by a shortcut actually needs.
if not exist "scripts\provision.ps1" goto :SETUPWINDOW
echo Prerequisites missing or incomplete - installing them now.
echo This takes a few minutes the first time. Nothing needs an administrator.
echo.
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\provision.ps1"
goto :SETUPRETRY

:SETUPWINDOW
if not exist "AURION.exe" goto :BYHAND
echo Prerequisites missing or incomplete - opening the setup window.
echo.
AURION.exe --setup

:SETUPRETRY
REM Setup installs Python with PATH changes that this already-running console
REM cannot see, so re-check in a fresh one rather than reporting a failure
REM that is only stale environment.
set "AURION_SETUP_DONE=1"
cmd /c ""%~f0""
exit /b %errorlevel%

:BYHAND
REM AURION.exe runs this script hidden, so a `pause` here is not a prompt -
REM it is a process that never returns, and the window sits on a progress bar
REM for three minutes before saying something vague about port 8080. Write the
REM reason where the window will read it, and leave.
call :SAYWHATSMISSING
if defined AURION_NO_BROWSER exit /b 1
echo Prerequisites missing or incomplete.
echo.
echo To do it by hand:
echo   Python 3.10 / 3.11 / 3.12  (never 3.13 or newer)  and Node.js 18+
echo   pip install -r engine\requirements.txt
echo   cd backend ^&^& npm install
echo.
pause
exit /b 1

:SAYWHATSMISSING
if not exist "data\logs" mkdir "data\logs" 2>nul
> "data\logs\desk.log" echo AURION cannot start: a prerequisite is missing.
if not defined PYCMD   >> "data\logs\desk.log" echo   - Python 3.10, 3.11 or 3.12 was not found.
if defined PYCMD       >> "data\logs\desk.log" echo   - Python: %PYCMD%
if not defined NODECMD >> "data\logs\desk.log" echo   - Node.js 18 or newer was not found.
if defined NODECMD     >> "data\logs\desk.log" echo   - Node: %NODECMD%
if not exist "backend\node_modules\express" >> "data\logs\desk.log" echo   - backend\node_modules is not installed.
>> "data\logs\desk.log" echo Run AURION.exe --setup to install what is missing.
goto :eof

:NOTREE
echo backend\src\index.js is missing.
echo This folder is not a complete AURION tree. Copy the full aurion folder to D:\aurion
pause
exit /b 1

:LAUNCH
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\copy-ea.ps1" >nul 2>nul

REM Free the AURION ports, but only when a leftover AURION process owns them.
REM Killing whatever happens to hold 8080 would take down unrelated software.
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$own=@('node','python','pythonw','py'); foreach($p in 8080,18765,18766){ Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if($proc -and ($own -contains $proc.ProcessName.ToLower())){ Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } }" >nul 2>nul

"%CSCRIPT%" //nologo "%~dp0scripts\hidden.vbs" "%CD%" "%CD%\data\logs\engine.log" %PYCMD% engine\main.py --host 127.0.0.1 --port 18765
time /t >nul
"%CSCRIPT%" //nologo "%~dp0scripts\hidden.vbs" "%CD%\backend" "%CD%\data\logs\desk.log" %NODECMD% src\index.js

REM Wait for the desk to answer instead of guessing with a fixed sleep, so the
REM browser never opens onto a connection-refused page.
echo   Waiting for the desk on http://127.0.0.1:8080 ...
"%PS%" -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 60;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8080/api/health; if($r.StatusCode -eq 200){$ok=$true;break} } catch {}; Start-Sleep -Milliseconds 700 }; if($ok){exit 0}else{exit 1}"
if errorlevel 1 goto :NOTREADY

REM AURION.exe hosts the desk in its own window and sets AURION_NO_BROWSER,
REM so a browser tab would be a duplicate. Without the variable - double-click
REM on this file, or any older shortcut - the behaviour is unchanged.
if not defined AURION_NO_BROWSER start "" "http://127.0.0.1:8080"

echo.
echo   Desk    http://127.0.0.1:8080
echo   Engine  127.0.0.1:18765
echo   EA      file inbox + HTTP on 127.0.0.1:18765
echo   Python  %PYCMD%
echo   Node    %NODECMD%
echo   Logs    dashboard Terminal tabs: Engine / Desk
echo   Stop    double-click stop-aurion.cmd
echo.
timeout /t 4 >nul
exit /b 0

:NOTREADY
echo.
echo   The desk did not answer within 45 seconds.
echo   Read the real error here:
echo     %CD%\data\logs\engine.log
echo     %CD%\data\logs\desk.log
echo   Common causes: port 8080 held by another program, or a missing
echo   Python/Node package. Repair packages with:
echo     powershell -ExecutionPolicy Bypass -File scripts\fix-npm.ps1
echo     powershell -ExecutionPolicy Bypass -File scripts\fix-numpy.ps1
echo.
if not defined AURION_NO_BROWSER start "" "http://127.0.0.1:8080"
timeout /t 8 >nul
exit /b 1

REM ---------------------------------------------------------------------------
REM Helpers
REM ---------------------------------------------------------------------------
REM ---------------------------------------------------------------------------
REM The runtimes setup recorded.
REM
REM PATH is the fragile way to find an interpreter: a console that started
REM before the install never sees it, Group Policy rewrites it, and a
REM per-user Node unpacked into the install folder is not on it at all. The
REM setup writes absolute paths here and they are believed first.
REM ---------------------------------------------------------------------------
:LOADRUNTIME
set "AURION_PY="
set "AURION_NODE="
if not exist "data\runtime.env" goto :eof
for /f "usebackq tokens=1,* delims==" %%A in ("data\runtime.env") do (
  if /i "%%A"=="PYTHON" set "AURION_PY=%%B"
  if /i "%%A"=="NODE"   set "AURION_NODE=%%B"
)
goto :eof

:FINDNODE
set "NODECMD="
if defined AURION_NODE if exist "%AURION_NODE%" set "NODECMD="%AURION_NODE%""
if defined NODECMD goto :eof
if exist "%~dp0runtime\node\node.exe" set "NODECMD="%~dp0runtime\node\node.exe""
if defined NODECMD goto :eof
where node >nul 2>nul
if not errorlevel 1 set "NODECMD=node"
if defined NODECMD goto :eof
if exist "%ProgramFiles%\nodejs\node.exe" set "NODECMD="%ProgramFiles%\nodejs\node.exe""
if defined NODECMD goto :eof
if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODECMD="%LOCALAPPDATA%\Programs\nodejs\node.exe""
goto :eof

:FINDPY
set "PYCMD="

REM AURION's own interpreter, before anything else - including before the
REM one recorded in runtime.env.
REM
REM The engine is pinned to a NumPy that only exists for CPython 3.9-3.12,
REM so following the machine's Python meant that upgrading it broke the
REM engine. And runtime.env is written once and then believed forever, so a
REM bad choice made on the first run outlived every repair attempt after it.
if exist "%~dp0runtime\python\python.exe" set "PYCMD="%~dp0runtime\python\python.exe""
if defined PYCMD goto :eof

REM An interpreter recorded on an earlier run - unless it is the Store one.
REM
REM %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe is not an interpreter.
REM It is an app execution alias: it resolves only inside an interactive
REM session belonging to the user who installed it, it redirects writes away
REM from site-packages, and started detached through wscript - which is how
REM the engine is started - it exits with no output and no log. That is why
REM a failed run reported four facts and two empty logs.
REM
REM Tested by substring removal rather than FIND. FIND parses its arguments
REM with C runtime rules, so the backslash in "\WindowsApps\" escaped the
REM closing quote and the search string arrived unterminated.
if defined AURION_PY (
  set "AURION_PY_CLEAN=%AURION_PY:WindowsApps=%"
)
if defined AURION_PY if "%AURION_PY_CLEAN%"=="%AURION_PY%" if exist "%AURION_PY%" set "PYCMD="%AURION_PY%""
if defined PYCMD goto :eof

where py >nul 2>nul
if errorlevel 1 goto :FINDPY_PLAIN
for %%V in (3.12 3.11 3.10) do (
  if not defined PYCMD (
    py -%%V -c "import sys" >nul 2>nul
    if not errorlevel 1 set "PYCMD=py -%%V"
  )
)
:FINDPY_PLAIN
if defined PYCMD goto :eof
python -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)" >nul 2>nul
if not errorlevel 1 set "PYCMD=python"
goto :eof

:REFRESHPATH
REM Pick up anything added to the PATH since this process started, without
REM destroying the PATH it already has.
REM
REM These two values are REG_EXPAND_SZ. `reg query` returns them raw, so
REM MACHINE_PATH arrives containing the literal text %SystemRoot%\system32,
REM and cmd will not expand that a second time. This routine used to assign
REM the result straight over PATH, which replaced a working PATH with a list
REM of unexpanded placeholders - and then nothing could be found at all. Not
REM python, not py, and not powershell, which is why the launcher reported
REM "no usable Python found" and came back with 9009, the code for a command
REM that does not exist.
REM
REM Appending fixes both halves: the inherited PATH keeps working, and the
REM placeholder entries are inert rather than fatal. The explicit list below
REM is what actually finds a freshly installed runtime.
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MACHINE_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
if defined MACHINE_PATH set "PATH=%PATH%;%MACHINE_PATH%"
if defined USER_PATH set "PATH=%PATH%;%USER_PATH%"
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts;%LOCALAPPDATA%\Programs\Python\Python310;%LOCALAPPDATA%\Programs\Python\Python310\Scripts;%LOCALAPPDATA%\Programs\Python\Launcher;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs"
goto :eof
