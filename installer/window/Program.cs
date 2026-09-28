using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

namespace Aurion.Window;

internal static class Program
{
    // One desk, one window. A second double-click on the shortcut should raise
    // the window that is already open instead of starting a second stack.
    private const string MutexName = @"Local\AxiaSoft.AURION.Window";

    // Without an explicit AppUserModelID Windows groups the window under the
    // generic host process and a pinned taskbar item can lose the AURION icon.
    private const string AppUserModelId = "AxiaSoft.AURION.Desk";

    [STAThread]
    private static void Main()
    {
        try { SetCurrentProcessExplicitAppUserModelID(AppUserModelId); }
        catch { /* older Windows: the window icon is still correct */ }

        using var single = new Mutex(initiallyOwned: true, MutexName, out bool isFirst);
        if (!isFirst)
        {
            RaiseExistingWindow();
            return;
        }

        // A desk must not greet a trader with a .NET crash dialog and a wall of
        // loaded assemblies. Anything unhandled is logged next to the app and
        // shown as one readable sentence; the window survives where it can.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => ReportFault(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => ReportFault(e.ExceptionObject as Exception);

        ApplicationConfiguration.Initialize();
        Application.Run(new AppWindow());
    }

    private static void ReportFault(Exception? ex)
    {
        if (ex is null) return;
        try
        {
            var log = Path.Combine(AppContext.BaseDirectory, "data", "logs", "window.log");
            Directory.CreateDirectory(Path.GetDirectoryName(log)!);
            File.AppendAllText(log, $"{DateTime.Now:u}  {ex}{Environment.NewLine}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never be the thing that takes the app down.
        }

        try
        {
            MessageBox.Show(
                "AURION hit an unexpected error:\n\n" + ex.Message +
                "\n\nThe desk usually keeps running. Details were written to" +
                "\ndata\\logs\\window.log",
                "AURION", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch
        {
            // Nothing left to do but let it go.
        }
    }

    private static void RaiseExistingWindow()
    {
        try
        {
            var me = Process.GetCurrentProcess();
            foreach (var p in Process.GetProcessesByName(me.ProcessName))
            {
                if (p.Id == me.Id || p.MainWindowHandle == IntPtr.Zero) continue;
                if (IsIconic(p.MainWindowHandle)) ShowWindow(p.MainWindowHandle, SW_RESTORE);
                SetForegroundWindow(p.MainWindowHandle);
                return;
            }
        }
        catch
        {
            // Raising the other window is a courtesy; never fail because of it.
        }
    }

    private const int SW_RESTORE = 9;

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SetCurrentProcessExplicitAppUserModelID(string appId);
}
