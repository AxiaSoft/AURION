' Run a command hidden, appending stdout/stderr to a log file.
' Usage: cscript //nologo hidden.vbs <workdir> <logfile> <command> [args...]
Option Explicit
If WScript.Arguments.Count < 3 Then
  WScript.Quit 1
End If

Dim sh, fso, workdir, logfile, i, cmd, arg
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

workdir = fso.GetAbsolutePathName(WScript.Arguments(0))
logfile = fso.GetAbsolutePathName(WScript.Arguments(1))

If Not fso.FolderExists(fso.GetParentFolderName(logfile)) Then
  fso.CreateFolder fso.GetParentFolderName(logfile)
End If

' WScript.Arguments hands back each argument with its quotes already
' stripped, so an interpreter under "C:\Program Files\nodejs" came back as
' three words and the desk never started. Anything containing a space is
' quoted again on the way into the command line.
cmd = ""
For i = 2 To WScript.Arguments.Count - 1
  arg = WScript.Arguments(i)
  If InStr(arg, " ") > 0 And Left(arg, 1) <> """" Then arg = """" & arg & """"
  If cmd <> "" Then cmd = cmd & " "
  cmd = cmd & arg
Next

sh.CurrentDirectory = workdir
' 0 = hidden window, False = do not wait.
' The whole command is wrapped in one more pair of quotes: cmd /c strips the
' outermost pair when the line starts with one, which would otherwise eat the
' quotes around a path that needs them.
sh.Run "cmd /c """ & cmd & " >> """ & logfile & """ 2>&1""", 0, False
