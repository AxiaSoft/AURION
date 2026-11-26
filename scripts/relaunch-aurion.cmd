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
REM Asked politely first so it can save its own state; the port sweep
REM below is what guarantees it is gone.
taskkill /im AURION.exe >nul 2>nul

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
call "%~dp0..\start-aurion.cmd"
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
call "%~dp0..\start-aurion.cmd"
exit /b 0
