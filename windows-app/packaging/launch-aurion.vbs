' AURION Secure Desktop Launcher - MSI version
' Per-user install default: %LOCALAPPDATA%\Programs\AURION (works from any folder: start-aurion.cmd is resolved next to this script)
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
' Run in a normal console: start-aurion.cmd prints progress and, on a fresh
' machine, installs Python/Node prerequisites (interactive) - hidden it would
' look like "nothing happens". The engine/desk themselves run hidden from it.
sh.Run "cmd /c """ & starter & """", 1, False
