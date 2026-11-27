@echo off
setlocal EnableExtensions
cd /d "%~dp0.."

REM Close AURION completely, then open it again.
REM
REM Asked for in these words: "after installing any update the
REM application should shut down once and open again, not restart."
REM
REM The difference is not cosmetic, and restart-aurion.cmd cannot be
REM made to do this by passing it a flag. That script stops the ENGINE
REM only - deliberately, with "-Scope engine" and a comment explaining
REM that freeing the desk's port as part of an engine restart is how a
REM failure once ended with nothing running at all. The desk window,
REM the WebView2 host and the Node process all survive it, and the page
REM merely reloads.
REM
REM That is exactly what makes it the wrong tool after an update.
REM Node has already required its modules and keeps them for the life
REM of the process, the shell has already loaded its assemblies, and
REM the service worker is holding a cached index.html. An update that
REM rewrites those files on disk leaves every one of them running the
REM old copy, which is the "it says installed and still behaves like
REM the old version" this exists to end.
REM
REM So this one takes everything down - engine, desk, window - waits
REM for the machine to be genuinely quiet, and starts the product from
REM nothing. Slower, and the only way to be sure.

set "LOG=%~dp0..\data\logs\desk.log"
if not exist "%~dp0..\data\logs" mkdir "%~dp0..\data\logs" >nul 2>nul

REM Settings first, before anything is stopped, or a shutdown loses
REM whatever the trader applied in the last few seconds.
powershell -NoProfile -ExecutionPolicy Bypass -Command "foreach($u in 'http://127.0.0.1:18765/v1/persist','http://127.0.0.1:18765/v1/shutdown'){ try { Invoke-WebRequest -UseBasicParsing -Method POST $u -TimeoutSec 5 | Out-Null } catch {} }" >nul 2>nul

timeout /t 2 /nobreak >nul

REM The window itself. Nothing else closes it: it is a WinForms shell
REM hosting WebView2, not a browser tab, and killing the ports beneath
REM it would leave an empty frame on screen saying it cannot reach the
REM desk - which looks exactly like the crash this is meant to avoid.
REM
REM Asked politely first so it can save its placement, and then made
REM to go.
REM
REM The polite request on its own was the reported fault: "I asked for
REM the whole application to close and come back after an update, and
REM the window never closes". taskkill without /f is a WM_CLOSE, which
REM is the same thing as pressing the X - and the X is a QUESTION. The
REM shell cancels it and puts the quit confirmation up, so the window
REM sat there with a modal on screen while everything underneath it
REM was stopped, and the page went blank because the desk it was
REM talking to had gone. Nobody was there to answer the question,
REM because the answer was given two minutes earlier by pressing
REM Install.
REM
REM So: ask, give it a few seconds to save and go, then end it. A
REM relaunch is not a request to the window; it is something already
REM decided.
taskkill /im AURION.exe >nul 2>nul
timeout /t 4 /nobreak >nul
tasklist /fi "imagename eq AURION.exe" 2>nul | find /i "AURION.exe" >nul
if not errorlevel 1 (
  >>"%LOG%" echo {"msg":"relaunch: the window did not close on request - ending it"}
  taskkill /f /im AURION.exe >nul 2>nul
  timeout /t 1 /nobreak >nul
)

REM Everything, this time - "-Scope all" includes the desk's own port,
REM which is the whole point of using this script instead of the other.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-engine.ps1" -Root "%~dp0.." -Scope all >>"%LOG%" 2>&1
if errorlevel 1 goto :HELD

REM Now that nothing is running, throw away every cache of the version
REM that just went.
REM
REM Asked for alongside the relaunch: "all the caches must be cleared
REM too, and then it comes back up on the new version automatically."
REM The updater clears what it can from inside the running process
REM (see purgeCaches), but the one cache that matters most cannot be
REM deleted from there - Windows holds the WebView2 cache open for as
REM long as AURION.exe is alive, and that cache is the desk's own
REM HTML, CSS and JavaScript. Deleting it here, in the gap between the
REM taskkill above and the start below, is the only moment it is
REM possible. Miss that gap and the new build comes up rendering the
REM old app.js, which is the whole complaint.
call :WIPE "%LOCALAPPDATA%\AxiaSoft\AURION\Window\EBWebView\Default\Cache"
call :WIPE "%LOCALAPPDATA%\AxiaSoft\AURION\Window\EBWebView\Default\Code Cache"
call :WIPE "%LOCALAPPDATA%\AxiaSoft\AURION\Window\EBWebView\Default\Service Worker"
call :WIPE "%LOCALAPPDATA%\AxiaSoft\AURION\Window\EBWebView\Default\GPUCache"
call :WIPE "%LOCALAPPDATA%\AxiaSoft\AURION\Window\EBWebView\ShaderCache"
call :WIPE "%LOCALAPPDATA%\AxiaSoft\AURION\Window\EBWebView\GrShaderCache"
call :WIPE "%~dp0..\data\cache"
call :WIPE "%~dp0..\data\tmp"

REM Quiet. Start the product as if it were being opened for the first
REM time today.
call :OPENWINDOW
exit /b 0

:OPENWINDOW
REM And put AURION back on screen.
REM
REM The second half of "it closes and never opens again", and the one
REM that is easy to miss because the product IS running afterwards:
REM start-aurion.cmd brings up the engine and the desk and stops
REM there. It opens a browser only when AURION_NO_BROWSER is NOT set -
REM and AURION.exe sets exactly that variable before it runs this
REM tree, so the desk process inherits it, and so does this script.
REM
REM For as long as the window survived an update, nobody noticed: the
REM relaunch restarted the services underneath a window that was still
REM on screen. Now that the window really closes - which is what was
REM asked for - the relaunch ended with two background processes, no
REM window, no browser tab and nothing for the trader to look at.
REM
REM So the window is opened here, by name. A browser is the fallback
REM for a tree that has no shell built next to it, and it is opened
REM whatever AURION_NO_BROWSER says: the window that set it is gone,
REM so the reason for it is gone too.
REM Two variables must NOT survive into what we start, and one of them
REM was the reported fault.
REM
REM AURION.exe sets AURION_OWNER_PID to its own pid for the desk it
REM launches, so the desk can shut the engine down if the window is
REM killed. That variable reached this script through the desk, and
REM this script had just killed the window it names. Starting the desk
REM from here therefore handed the new desk the pid of a process that
REM no longer existed; it looked its owner up, found a corpse, and shut
REM itself and the engine down within two seconds of starting.
REM
REM That is "the update finishes, it shuts down, and the app closes" -
REM and the second report too: when the window happened to win the
REM race, the trader was looking at a desk that was already on its way
REM out, with no MetaTrader connection and no expert advisors, which
REM one manual close-and-open then fixed.
REM
REM AURION_NO_BROWSER goes for the same kind of reason: it was set by a
REM window that is gone, so the reason for it is gone too.
set "AURION_OWNER_PID="
set "AURION_NO_BROWSER="

REM The window starts the product, not us.
REM
REM This script used to call start-aurion.cmd and then open the window,
REM which started everything TWICE: start-aurion.cmd begins by running
REM stop-engine.ps1, so AURION.exe's own launch stopped the engine and
REM desk that had just been brought up here and started them again,
REM while the first desk was still shutting itself down over the stale
REM owner pid above. Three processes racing for two ports is why the
REM engine sometimes came up without its EA bridge.
REM
REM Letting the window do it is also the only way the new desk gets a
REM CORRECT owner pid, which is the whole point of the variable.
if exist "%~dp0..\AURION.exe" (
  start "" "%~dp0..\AURION.exe"
  >>"%LOG%" echo {"msg":"relaunch: the window was started again"}
  REM ...but not blindly. If the shell cannot start - a missing
  REM WebView2 runtime, a blocked executable - then nothing at all is
  REM running, which is the worst outcome of the two. Give it time to
  REM appear and fall back to the launcher if it does not.
  timeout /t 12 /nobreak >nul
  tasklist /fi "imagename eq AURION.exe" 2>nul | find /i "AURION.exe" >nul
  if not errorlevel 1 exit /b 0
  >>"%LOG%" echo {"msg":"relaunch: the window did not stay up - starting the services directly"}
)
call "%~dp0..\start-aurion.cmd"
start "" "http://127.0.0.1:8080"
>>"%LOG%" echo {"msg":"relaunch: opened the desk in a browser"}
exit /b 0

:WIPE
REM A cache that will not delete is not a reason to refuse to start -
REM the worst it costs is one stale file, and refusing would leave the
REM trader with nothing running at all.
if exist %1 rd /s /q %1 >nul 2>nul
exit /b 0

:HELD
REM Something would not let go of a port. Start anyway, for the same
REM reason restart-aurion.cmd does: "nothing runs" is not the safe
REM outcome of a failed shutdown, it is the worst one - no desk, no
REM window, and nowhere to read why. The engine refuses to start a
REM second copy on a held port and the desk reports a build mismatch
REM on screen, so starting is visible rather than silently wrong.
echo AURION could not be stopped completely - see data\logs\desk.log
echo Opening it anyway so the problem can be seen and acted on.
>>"%LOG%" echo {"msg":"relaunch: a port was still held; opening the desk anyway so the state is visible"}
call :OPENWINDOW
exit /b 0
