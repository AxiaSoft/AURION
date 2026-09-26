' Run a command hidden, appending stdout/stderr to a log file.
' Usage: cscript //nologo hidden.vbs <workdir> <logfile> <command> [args...]
Option Explicit
If WScript.Arguments.Count < 3 Then
  WScript.Quit 1
End If

Dim sh, fso, workdir, logfile, i, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

workdir = fso.GetAbsolutePathName(WScript.Arguments(0))
logfile = fso.GetAbsolutePathName(WScript.Arguments(1))

If Not fso.FolderExists(fso.GetParentFolderName(logfile)) Then
  fso.CreateFolder fso.GetParentFolderName(logfile)
End If

cmd = ""
For i = 2 To WScript.Arguments.Count - 1
  If cmd <> "" Then cmd = cmd & " "
  cmd = cmd & WScript.Arguments(i)
Next

sh.CurrentDirectory = workdir
' 0 = hidden window, False = do not wait
sh.Run "cmd /c " & cmd & " >> """ & logfile & """ 2>&1", 0, False
