' ---------------------------------------------------------------------------
'  AURION launcher  (installed by the AURION MSI, not part of the application)
'
'  Start Menu / Desktop shortcuts point here instead of straight at
'  start-aurion.cmd so that:
'    * the console window opens minimised instead of flashing in the user's face
'    * the working directory is always the install folder, whatever the shortcut
'    * a second launch does not stack another engine on top of a running one
'
'  It intentionally does NOT re-implement any application logic: all the real
'  work still happens in the application's own start-aurion.cmd.
' ---------------------------------------------------------------------------
Option Explicit

Dim shell, fso, here, starter
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
starter = fso.BuildPath(here, "start-aurion.cmd")

If Not fso.FileExists(starter) Then
    MsgBox "AURION is not installed correctly:" & vbCrLf & vbCrLf & _
           starter & " is missing." & vbCrLf & vbCrLf & _
           "Use Settings > Apps > AURION > Modify > Repair to restore it.", _
           vbCritical, "AURION"
    WScript.Quit 1
End If

' Already up? Just open the desk instead of starting a second stack.
If DeskIsAnswering() Then
    shell.Run "http://127.0.0.1:8080", 1, False
    WScript.Quit 0
End If

shell.CurrentDirectory = here
' 7 = minimised, without focus. Not hidden: if start-aurion.cmd needs to report
' a missing prerequisite the user must be able to read it.
shell.Run """" & starter & """", 7, False

' The stack takes a few seconds to come up, and until then nothing is visible
' on screen because the console is minimised. Wait for the desk to answer and
' then open it, so clicking the shortcut always leads somewhere.
Dim waited
waited = 0
Do While waited < 90
    WScript.Sleep 1000
    waited = waited + 1
    If DeskIsAnswering() Then
        shell.Run "http://127.0.0.1:8080", 1, False
        WScript.Quit 0
    End If
Loop

' Still nothing after a minute and a half: say so plainly instead of leaving
' the user staring at an empty desktop. The console is still open, minimised,
' and holds the real reason (usually a missing Python 3.10-3.12 or Node.js).
MsgBox "AURION did not finish starting." & vbCrLf & vbCrLf & _
       "Open the minimised AURION window in the taskbar - it shows what went " & _
       "wrong. The usual cause is a missing prerequisite: Python 3.10, 3.11 " & _
       "or 3.12, or Node.js 18+." & vbCrLf & vbCrLf & _
       "Once the desk is running it is at http://127.0.0.1:8080", _
       vbExclamation, "AURION"
WScript.Quit 1


Function DeskIsAnswering()
    Dim http
    DeskIsAnswering = False
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    If Err.Number <> 0 Then Exit Function
    http.setTimeouts 700, 700, 700, 1200
    http.open "GET", "http://127.0.0.1:8080/api/health", False
    http.send
    If Err.Number = 0 Then
        If http.status = 200 Then DeskIsAnswering = True
    End If
    Err.Clear
End Function
