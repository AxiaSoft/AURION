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

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        ApplicationConfiguration.Initialize();
        Application.Run(new SetupWindow(msi, Msi.InstalledProductCode("").Length > 0));
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
}
