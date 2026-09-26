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
WScript.Quit 0


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
