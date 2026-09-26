' ---------------------------------------------------------------------------
'  AURION stop helper  (installed by the AURION MSI)
'
'  Wraps the application's own stop-aurion.cmd so the Start Menu entry, and the
'  installer's "close the running desk" step, both go through one quiet path.
'
'  Exit code 0 = AURION is not running any more.
' ---------------------------------------------------------------------------
Option Explicit

Dim shell, fso, here, stopper, rc
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
stopper = fso.BuildPath(here, "stop-aurion.cmd")

If Not fso.FileExists(stopper) Then WScript.Quit 0   ' nothing installed to stop

shell.CurrentDirectory = here
' 0 = hidden, True = wait. Shutting down must complete before the installer
' starts deleting files underneath the engine.
rc = shell.Run("""" & stopper & """", 0, True)

WScript.Quit 0
