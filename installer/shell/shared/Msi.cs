using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Aurion.Shell;

/// <summary>
/// Drives msiexec and turns it back into something worth watching.
///
/// Both of AURION's installers run Windows Installer with /qn - fully
/// silent - because the whole point of them is that the user is looking at
/// AURION's window instead of Microsoft's. Silent also means msiexec says
/// nothing at all while it works, and a progress bar that cannot move is
/// the thing people kill.
///
/// So it is run with a verbose log and the log is tailed. Windows Installer
/// writes a line every time it starts an action:
///
///     Action 22:36:11: InstallFiles. Copying new files
///
/// The half after the full stop is written for exactly this purpose - it is
/// the text Microsoft's own progress dialog shows - and it is free.
/// </summary>
internal static class Msi
{
    /// <summary>What msiexec said, mapped to something a person can act on.</summary>
    public static string Explain(int code) => code switch
    {
        0 => "",
        1602 => "The installation was cancelled.",
        1603 => "The installation hit a fatal error. Antivirus holding a file open is the usual cause.",
        1605 => "That version of AURION is not installed on this machine.",
        1618 => "Windows is already installing something else. Wait for it to finish and try again.",
        1619 => "The installation package could not be opened.",
        1620 => "The installation package is damaged.",
        1625 => "A policy on this machine forbids installing software.",
        1638 => "Another version of AURION is already installed.",
        3010 => "",      // success, wants a restart - never true for AURION
        _ => $"Windows Installer stopped with code {code}.",
    };

    public static bool Succeeded(int code) => code == 0 || code == 3010;

    /// <summary>
    /// Run msiexec to completion, reporting each action as it starts.
    /// </summary>
    /// <param name="arguments">Everything after msiexec.exe, without /qn or /l.</param>
    /// <param name="logPath">Where the verbose log goes. Also the progress source.</param>
    /// <param name="say">Receives the human half of each "Action" line.</param>
    public static async Task<int> RunAsync(
        string arguments, string logPath, IProgress<string> say, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);

        // Started fresh, so the tail below cannot report an action from a
        // previous run as though it were happening now. The desk window had
        // exactly that bug and it quoted a successful start from three
        // weeks earlier as the reason a launch had failed.
        try { if (File.Exists(logPath)) File.Delete(logPath); } catch { }

        var psi = new ProcessStartInfo
        {
            FileName = "msiexec.exe",
            Arguments = $"{arguments} /qn /norestart /l*v \"{logPath}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("msiexec could not be started.");

        using var watching = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var tail = Task.Run(() => TailAsync(logPath, say, watching.Token), watching.Token);

        try
        {
            await proc.WaitForExitAsync(ct);
        }
        finally
        {
            watching.Cancel();
            try { await tail; } catch (OperationCanceledException) { }
        }

        return proc.ExitCode;
    }

    private static readonly Regex ActionLine =
        new(@"^Action\s+[\d:]+:\s+\w+\.\s*(?<said>.+?)\s*$", RegexOptions.Compiled);

    /// <summary>
    /// Follow the log and report what Windows Installer is doing.
    ///
    /// FileShare.ReadWrite throughout: msiexec holds the file open for
    /// writing the whole time, and opening it any other way fails.
    /// </summary>
    private static async Task TailAsync(string path, IProgress<string> say, CancellationToken ct)
    {
        var position = 0L;
        var last = "";

        while (!ct.IsCancellationRequested)
        {
            try
            {
                if (File.Exists(path))
                {
                    using var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete);
                    if (stream.Length > position)
                    {
                        stream.Position = position;
                        using var reader = new StreamReader(stream);
                        var text = await reader.ReadToEndAsync(ct);
                        position = stream.Length;

                        foreach (var raw in text.Split('\n'))
                        {
                            var match = ActionLine.Match(raw.Trim());
                            if (!match.Success) continue;

                            var said = match.Groups["said"].Value;

                            // Windows Installer names a lot of internal
                            // bookkeeping. Only the lines with a sentence
                            // after the action name are meant to be read.
                            if (said.Length < 8 || said == last) continue;
                            last = said;
                            say.Report(said);
                        }
                    }
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
                // A log that cannot be read costs a progress line, nothing
                // more. It must never be the reason an install fails.
            }

            try { await Task.Delay(400, ct); } catch (OperationCanceledException) { return; }
        }
    }

    /// <summary>
    /// The ProductCode AURION is registered under, or "".
    ///
    /// Read from AURION's own key, which the MSI writes as an ordinary
    /// component. Scanning Add or Remove Programs for it used to work and
    /// no longer can: AURION hides Windows Installer's entry and writes
    /// its own, whose key is named AURION rather than a GUID - so the scan
    /// would hand msiexec the word "AURION" and be told there is no such
    /// product.
    /// </summary>
    public static string InstalledProductCode(string fallback)
    {
        foreach (var root in new[] { Microsoft.Win32.Registry.CurrentUser,
                                     Microsoft.Win32.Registry.LocalMachine })
        {
            try
            {
                using var key = root.OpenSubKey(@"Software\AxiaSoft\AURION");
                var code = key?.GetValue("ProductCode") as string ?? "";
                if (code.StartsWith('{') && code.EndsWith('}')) return code;
            }
            catch
            {
                // An unreadable key means "not installed", never a crash.
            }
        }
        return fallback;
    }
}
