using System.Windows.Forms;

namespace Aurion.Shell;

/// <summary>
/// AURION-Setup.exe
///
/// The single thing a customer is given. It finds the MSI, shows AURION's
/// own wizard, and runs Windows Installer silently underneath.
///
/// The MSI is still doing the installing. Everything Windows Installer is
/// good at - upgrades, rollback, repair, Add or Remove Programs - keeps
/// working exactly as before. The only thing being replaced is the set of
/// dialogs, which is the only part of it that was ever AURION's problem.
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var msi = Locate(args);
        if (msi.Length == 0)
        {
            MessageBox.Show(
                "The AURION installation package could not be found.\n\n"
                + "AURION-Setup.exe expects the .msi file to be in the same folder as "
                + "itself. If they were separated, put them back together and run this "
                + "again.",
                "AURION", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1619;      // ERROR_INSTALL_PACKAGE_OPEN_FAILED
        }

        // Nothing here is allowed to fail invisibly.
        //
        // The window is built inside Application.Run's argument, which is
        // before the message loop exists - so WinForms' own exception
        // handling is not running yet, and an exception from a control's
        // constructor kills a WinExe process with no window, no message
        // and nothing in any log. This program did exactly nothing when
        // double-clicked, every time, because one control set
        // BackColor = Color.Transparent without
        // ControlStyles.SupportsTransparentBackColor.
        //
        // An installer that can die in silence is unsupportable: the
        // person it fails for is a customer, on a machine nobody here can
        // see, and their whole report is "it does not open".
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => Fault(e.Exception);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Fault(e.ExceptionObject as Exception);

        try
        {
            ApplicationConfiguration.Initialize();
            Application.Run(new SetupWindow(msi, Msi.InstalledProductCode("").Length > 0));
        }
        catch (Exception ex)
        {
            Fault(ex);
            return 1603;
        }
        return 0;
    }

    /// <summary>
    /// Where the package is: told, or beside the exe, or one folder down.
    ///
    /// Beside the exe is the normal case - the build puts both in
    /// installer\output and they travel together. The rest is for the
    /// times they do not.
    /// </summary>
    private static string Locate(string[] args)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], "--package", StringComparison.OrdinalIgnoreCase)
                && File.Exists(args[i + 1]))
            {
                return args[i + 1];
            }
        }

        var here = Path.GetDirectoryName(Environment.ProcessPath ?? "") ?? "";
        if (here.Length == 0) return "";

        foreach (var folder in new[] { here, Path.Combine(here, "package") })
        {
            if (!Directory.Exists(folder)) continue;

            // Newest first: a folder that has accumulated two builds should
            // install the one somebody just made.
            var found = Directory.GetFiles(folder, "AURION*.msi")
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
            if (found is not null) return found;
        }
        return "";
    }

    /// <summary>Say what went wrong, somewhere a person will find it.</summary>
    private static void Fault(Exception? ex)
    {
        if (ex is null) return;
        var log = Path.Combine(Path.GetTempPath(), "AURION-setup-fault.log");
        try { File.AppendAllText(log, $"{DateTime.Now:u}  {ex}{Environment.NewLine}"); } catch { }

        try
        {
            MessageBox.Show(
                "AURION setup could not start.\n\n" + ex.Message
                + "\n\nThe details are in:\n    " + log,
                "AURION", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        catch
        {
            // Nothing left to try.
        }
    }

}
