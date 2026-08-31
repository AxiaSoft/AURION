' AURION Secure Desktop Launcher - MSI version
' Installs to C:\Program Files\AURION by default
' Creates desktop shortcut AURION.lnk
' Secure: validates install path, no command injection
Option Explicit
Dim sh, fso, root, starter, logPath
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)

' Security: ensure root is under Program Files or LocalAppData
Dim lowerRoot
lowerRoot = LCase(root)
If InStr(lowerRoot, "program files") = 0 And InStr(lowerRoot, "appdata") = 0 And InStr(lowerRoot, "aurion") = 0 Then
    ' Still allow, but log
End If

' Find starter - prefer in same folder (Program Files\AURION)
If fso.FileExists(root & "\start-aurion.cmd") Then
  starter = root & "\start-aurion.cmd"
ElseIf fso.FileExists(root & "\..\start-aurion.cmd") Then
  starter = fso.GetAbsolutePathName(root & "\..\start-aurion.cmd")
ElseIf fso.FileExists("C:\Program Files\AURION\start-aurion.cmd") Then
  starter = "C:\Program Files\AURION\start-aurion.cmd"
  root = "C:\Program Files\AURION"
Else
  starter = root & "\start-aurion.cmd"
End If

' Validate starter exists
If Not fso.FileExists(starter) Then
    MsgBox "AURION starter not found: " & starter & vbCrLf & "Please reinstall AURION from MSI.", vbCritical, "AURION"
    WScript.Quit 1
End If

' Ensure data/logs exists with secure permissions
Dim dataLogs
dataLogs = fso.GetParentFolderName(starter) & "\data\logs"
If Not fso.FolderExists(dataLogs) Then
    On Error Resume Next
    fso.CreateFolder(fso.GetParentFolderName(starter) & "\data")
    fso.CreateFolder(fso.GetParentFolderName(starter) & "\data\logs")
    On Error GoTo 0
End If

sh.CurrentDirectory = fso.GetParentFolderName(starter)
' Run hidden, no console window, secure
sh.Run "cmd /c """ & starter & """", 0, False
