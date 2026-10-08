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
call :FINDPY
if not defined PYCMD goto :NEEDINSTALL
%PYCMD% -c "import fastapi,numpy,sklearn" >nul 2>nul
if errorlevel 1 goto :NEEDINSTALL
where node >nul 2>nul
if errorlevel 1 goto :NEEDINSTALL
if not exist "backend\node_modules\express" goto :NEEDINSTALL
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
if not exist "AURION.exe" goto :BYHAND

echo Prerequisites missing or incomplete - opening the setup window.
echo.
AURION.exe --setup

REM Setup installs Python and Node with PATH changes that this already-running
REM console cannot see, so re-check in a fresh one rather than reporting a
REM failure that is only stale environment.
set "AURION_SETUP_DONE=1"
cmd /c ""%~f0""
exit /b %errorlevel%

:BYHAND
echo Prerequisites missing or incomplete.
echo.
echo To do it by hand:
echo   Python 3.10 / 3.11 / 3.12  (never 3.13 or newer)  and Node.js 18+
echo   pip install -r engine\requirements.txt
echo   cd backend ^&^& npm install
echo.
pause
exit /b 1

:NOTREE
echo backend\src\index.js is missing.
echo This folder is not a complete AURION tree. Copy the full aurion folder to D:\aurion
pause
exit /b 1

:LAUNCH
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\copy-ea.ps1" >nul 2>nul

REM Free the AURION ports, but only when a leftover AURION process owns them.
REM Killing whatever happens to hold 8080 would take down unrelated software.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$own=@('node','python','pythonw','py'); foreach($p in 8080,18765,18766){ Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $proc = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if($proc -and ($own -contains $proc.ProcessName.ToLower())){ Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } }" >nul 2>nul

cscript //nologo "%~dp0scripts\hidden.vbs" "%CD%" "%CD%\data\logs\engine.log" %PYCMD% engine\main.py --host 127.0.0.1 --port 18765
time /t >nul
cscript //nologo "%~dp0scripts\hidden.vbs" "%CD%\backend" "%CD%\data\logs\desk.log" node src\index.js

REM Wait for the desk to answer instead of guessing with a fixed sleep, so the
REM browser never opens onto a connection-refused page.
echo   Waiting for the desk on http://127.0.0.1:8080 ...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ok=$false; for($i=0;$i -lt 60;$i++){ try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8080/api/health; if($r.StatusCode -eq 200){$ok=$true;break} } catch {}; Start-Sleep -Milliseconds 700 }; if($ok){exit 0}else{exit 1}"
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
:FINDPY
set "PYCMD="
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
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do set "MACHINE_PATH=%%B"
for /f "tokens=2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do set "USER_PATH=%%B"
if defined MACHINE_PATH if defined USER_PATH set "PATH=%MACHINE_PATH%;%USER_PATH%"
if defined MACHINE_PATH if not defined USER_PATH set "PATH=%MACHINE_PATH%"
set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%LOCALAPPDATA%\Programs\Python\Python311;%LOCALAPPDATA%\Programs\Python\Python311\Scripts;%LOCALAPPDATA%\Programs\Python\Python310;%LOCALAPPDATA%\Programs\Python\Python310\Scripts;%LOCALAPPDATA%\Programs\Python\Launcher;%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs"
goto :eof
