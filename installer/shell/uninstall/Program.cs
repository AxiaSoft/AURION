using System.Windows.Forms;

namespace Aurion.Shell;

/// <summary>
/// AURION-Uninstall.exe
///
/// This is what Control Panel runs. The MSI's UninstallString is rewritten
/// to point here instead of at msiexec, so "Uninstall" in Settings or in
/// Add or Remove Programs opens AURION's own window rather than Windows'
/// anonymous progress bar.
///
/// It takes the ProductCode on the command line because the build knows it
/// and the registry entry can pass it for free. When it is missing - a copy
/// run by hand, or left behind by an older version - it is looked up.
/// </summary>
internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var productCode = Argument(args, "--product") ;
        var installFolder = Argument(args, "--folder");

        if (productCode.Length == 0)
        {
            productCode = Msi.InstalledProductCode("");
        }

        if (productCode.Length == 0)
        {
            MessageBox.Show(
                "AURION does not appear to be installed for this user.\n\n"
                + "Nothing was changed.",
                "AURION", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1605;      // ERROR_UNKNOWN_PRODUCT
        }

        // Copied to a temporary folder before doing anything.
        //
        // Windows Installer deletes the installation directory during an
        // uninstall, and this program lives in it. Running from where it is
        // installed means deleting the exe out from under its own process:
        // on a good day the uninstall leaves the folder behind because one
        // file is locked, and on a bad day it fails halfway.
        if (!Relaunched(args) && RelaunchFromTemp(productCode, installFolder)) return 0;

        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        ApplicationConfiguration.Initialize();
        Application.Run(new UninstallWindow(productCode, installFolder));
        return 0;
    }

    private static string Argument(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
            {
                return args[i + 1];
            }
        }
        return "";
    }

    private static bool Relaunched(string[] args) =>
        args.Any(a => string.Equals(a, "--relaunched", StringComparison.OrdinalIgnoreCase));

    private static bool RelaunchFromTemp(string productCode, string installFolder)
    {
        try
        {
            var self = Environment.ProcessPath;
            if (string.IsNullOrEmpty(self)) return false;

            var folder = installFolder.Length > 0
                ? installFolder
                : Path.GetDirectoryName(self) ?? "";

            var temp = Path.Combine(Path.GetTempPath(),
                "AURION-uninstall-" + Guid.NewGuid().ToString("N")[..8]);
            Directory.CreateDirectory(temp);

            var copy = Path.Combine(temp, Path.GetFileName(self));
            File.Copy(self, copy, overwrite: true);

            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = copy,
                Arguments = $"--relaunched --product {productCode} --folder \"{folder}\"",
                UseShellExecute = false,
                WorkingDirectory = temp,
            });
            return true;
        }
        catch
        {
            // Could not copy itself out: carry on in place. The uninstall
            // still works, it just may leave the folder behind.
            return false;
        }
    }
}
