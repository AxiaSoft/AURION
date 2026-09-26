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
'
'  The desk is opened as a standalone window rather than a browser tab, using
'  the Chromium "app mode" that ships with Microsoft Edge on every supported
'  version of Windows: no address bar, no tabs, its own taskbar button. This
'  needs no runtime, no download and no change to the application itself.
' ---------------------------------------------------------------------------
Option Explicit

Const DESK_URL = "http://127.0.0.1:8080"
Const WIN_W = 1270            ' opening size, deliberately not maximised
Const WIN_H = 720

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
    OpenDesk
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
        OpenDesk
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
       "Once the desk is running it is at " & DESK_URL, _
       vbExclamation, "AURION"
WScript.Quit 1


Function DeskIsAnswering()
    Dim http
    DeskIsAnswering = False
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    If Err.Number <> 0 Then Exit Function
    http.setTimeouts 700, 700, 700, 1200
    http.open "GET", DESK_URL & "/api/health", False
    http.send
    If Err.Number = 0 Then
        If http.status = 200 Then DeskIsAnswering = True
    End If
    Err.Clear
End Function


' ---------------------------------------------------------------------------
'  Open the desk in its own window.
'
'  Chromium app mode (--app) gives a frameless application window with no
'  address bar or tabs and its own taskbar entry, which is as close to a native
'  window as you get without shipping a second runtime. Edge is present on every
'  supported Windows version; Chrome is accepted too, and if neither is found
'  the default browser is used so the desk is always reachable.
'
'  --user-data-dir keeps this window out of the user's own browser session:
'  their tabs, profile and extensions are untouched, and the window geometry
'  below is remembered separately. The size is applied on first open and after
'  that Windows remembers what the user chose, which is the behaviour people
'  expect from a desktop application.
' ---------------------------------------------------------------------------
Sub OpenDesk()
    Dim exe, profile, cmd
    exe = FindAppWindowHost()

    If exe = "" Then
        shell.Run DESK_URL, 1, False
        Exit Sub
    End If

    profile = fso.BuildPath(shell.ExpandEnvironmentStrings("%LOCALAPPDATA%"), _
                            "AxiaSoft\AURION\Window")
    EnsureFolder profile

    cmd = """" & exe & """" & _
          " --app=" & DESK_URL & _
          " --window-size=" & WIN_W & "," & WIN_H & _
          " --user-data-dir=""" & profile & """" & _
          " --no-first-run --no-default-browser-check"
    shell.Run cmd, 1, False
End Sub


Function FindAppWindowHost()
    Dim candidates, i, p
    FindAppWindowHost = ""

    ' Registered locations first, so a non-standard install is still found.
    candidates = Array( _
        RegPath("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe\"), _
        RegPath("HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe\"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe"), _
        shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"), _
        shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"))

    For i = 0 To UBound(candidates)
        p = candidates(i)
        If p <> "" Then
            If fso.FileExists(p) Then
                FindAppWindowHost = p
                Exit Function
            End If
        End If
    Next
End Function


Function RegPath(key)
    RegPath = ""
    On Error Resume Next
    RegPath = shell.RegRead(key)
    If Err.Number <> 0 Then RegPath = ""
    Err.Clear
End Function


Sub EnsureFolder(path)
    Dim parent
    If fso.FolderExists(path) Then Exit Sub
    parent = fso.GetParentFolderName(path)
    If parent <> "" Then EnsureFolder parent
    On Error Resume Next
    fso.CreateFolder path
    Err.Clear
End Sub
