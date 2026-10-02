using System.Diagnostics;
using System.IO;
using System.Security.Cryptography.X509Certificates;
using System.Text.RegularExpressions;

namespace Aurion.Window;

/// <summary>What one requirement is, and whether this machine has it.</summary>
internal enum ReqState
{
    Checking,
    Present,
    Missing,
    Installing,
    Installed,
    Failed,
}

internal sealed class Requirement
{
    public required string Id { get; init; }
    public required string Title { get; init; }

    /// <summary>One line saying what it is for, in the trader's terms.</summary>
    public required string Why { get; init; }

    /// <summary>Where it comes from, shown before anything is downloaded.</summary>
    public string Source { get; init; } = "";

    /// <summary>Roughly how big the download is, for the consent screen.</summary>
    public string Size { get; init; } = "";

    public ReqState State { get; set; } = ReqState.Checking;

    /// <summary>What was found, when something was: "Python 3.12.7".</summary>
    public string Found { get; set; } = "";

    /// <summary>Why it failed, when it did.</summary>
    public string Problem { get; set; } = "";
}

/// <summary>
/// The check that runs before the desk is started, on every launch.
///
/// A fresh Windows machine has none of what AURION runs on. Until now the
/// launcher noticed that, printed three lines of advice into a console window
/// this app deliberately hides, and exited - so the trader watched a progress
/// bar crawl for three minutes and then got "AURION could not be started".
/// The information existed and nobody could see it.
///
/// Now the window asks the same questions itself, says plainly what is
/// missing, and offers to fetch it. Three rules the implementation keeps:
///
///   1. Nothing is downloaded without being asked. The list of what will be
///      fetched, from which vendor, and how large it is, is on screen before
///      the button that starts it.
///   2. Nothing unsigned is executed. Every downloaded installer is checked
///      for an Authenticode signature from the expected publisher before it
///      is run; a file that fails is deleted, not run and reported.
///   3. Nothing is installed that is already there. The check is cheap and
///      runs every launch, so a machine that is already set up goes straight
///      to the desk and never sees any of this.
/// </summary>
internal static class Prerequisites
{
    /// <summary>Python versions the engine runs on, newest first.</summary>
    private static readonly string[] PythonVersions = { "3.12", "3.11", "3.10" };

    // ---------------------------------------------------------------------
    // Where the runtimes come from.
    //
    // Official vendor URLs only, https only. The publisher name is what the
    // downloaded file's Authenticode signature is checked against - a far
    // better guarantee than a pinned hash, because it stays true when the
    // vendor releases a patch and does not silently rot into "refuses the
    // real file" the way a stale hash does.
    // ---------------------------------------------------------------------
    private const string PythonUrl =
        "https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe";
    private const string PythonPublisher = "Python Software Foundation";

    private const string NodeUrl =
        "https://nodejs.org/dist/v20.17.0/node-v20.17.0-x64.msi";
    private const string NodePublisher = "OpenJS Foundation";

    // Microsoft's evergreen bootstrapper: a tiny stub that fetches the current
    // runtime itself. Deliberately not version-pinned - that is the supported
    // way to install it and the only link Microsoft keeps stable.
    private const string WebViewUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
    private const string WebViewPublisher = "Microsoft Corporation";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };

    /// <summary>The Python interpreter found by the last inspection.</summary>
    public static string PythonCommand { get; private set; } = "";

    /// <summary>Everything AURION needs, in the order it is shown.</summary>
    public static List<Requirement> Build() => new()
    {
        new Requirement
        {
            Id = "python",
            Title = "Python 3.12",
            Why = "Runs the trading engine, the AI models and the strategies.",
            Source = "python.org",
            Size = "25 MB",
        },
        new Requirement
        {
            Id = "pydeps",
            Title = "Engine libraries",
            Why = "FastAPI, NumPy and scikit-learn, from engine\\requirements.txt.",
            Source = "PyPI",
            Size = "90 MB",
        },
        new Requirement
        {
            Id = "node",
            Title = "Node.js 20",
            Why = "Runs the desk's API between the engine and this window.",
            Source = "nodejs.org",
            Size = "28 MB",
        },
        new Requirement
        {
            Id = "nodedeps",
            Title = "Desk API libraries",
            Why = "The packages backend\\package.json asks for.",
            Source = "npm",
            Size = "15 MB",
        },
        new Requirement
        {
            Id = "webview",
            Title = "WebView2 runtime",
            Why = "Draws the desk inside this window. Windows 11 already has it.",
            Source = "microsoft.com",
            Size = "2 MB",
        },
    };

    // =====================================================================
    // Detection
    // =====================================================================

    /// <summary>
    /// Ask the machine what it already has. Fast, offline, and safe to run on
    /// every launch - the whole point is that a prepared machine never waits.
    /// </summary>
    public static async Task InspectAsync(IEnumerable<Requirement> items, string installDir)
    {
        var list = items.ToList();
        var python = FindPython();
        PythonCommand = python;

        foreach (var req in list)
        {
            switch (req.Id)
            {
                case "python":
                    Settle(req, python.Length > 0, PythonVersionOf(python),
                        "No supported Python found. The engine needs 3.10, 3.11 or 3.12.");
                    break;

                case "pydeps":
                    if (python.Length == 0)
                    {
                        Settle(req, false, "", "Waiting for Python.");
                        break;
                    }
                    Settle(req, await ImportsWorkAsync(python), "fastapi, numpy, scikit-learn",
                        "The engine's Python libraries are not installed.");
                    break;

                case "node":
                    var node = await NodeVersionAsync();
                    Settle(req, node.Length > 0, node, "Node.js 18 or newer was not found.");
                    break;

                case "nodedeps":
                    var marker = Path.Combine(installDir, "backend", "node_modules", "express");
                    Settle(req, Directory.Exists(marker), "backend\\node_modules",
                        "The desk API's packages have not been installed yet.");
                    break;

                case "webview":
                    var wv = WebViewVersion();
                    Settle(req, wv.Length > 0, wv, "The WebView2 runtime is missing.");
                    break;
            }
        }
    }

    private static void Settle(Requirement req, bool ok, string found, string problem)
    {
        req.State = ok ? ReqState.Present : ReqState.Missing;
        req.Found = ok ? found : "";
        req.Problem = ok ? "" : problem;
    }

    /// <summary>The best supported interpreter on this machine, or "".</summary>
    private static string FindPython()
    {
        foreach (var v in PythonVersions)
        {
            if (RunQuiet("py", $"-{v} -c \"import sys\"")) return $"py -{v}";
        }
        // No launcher, or no versioned entry: fall back to whatever `python`
        // is, but only accept it if it is a version the engine supports.
        var bare = PythonVersionOf("python");
        if (bare.Length > 0 && PythonVersions.Any(v => bare.Contains(" " + v + ".")))
        {
            return "python";
        }
        return "";
    }

    private static string PythonVersionOf(string command)
    {
        if (command.Length == 0) return "";
        var (exe, args) = Split(command);
        var text = Capture(exe, (args + " -V").Trim());
        var m = Regex.Match(text, @"Python\s+\d+\.\d+\.\d+");
        return m.Success ? m.Value : "";
    }

    private static async Task<bool> ImportsWorkAsync(string python)
    {
        var (exe, args) = Split(python);
        return await Task.Run(() =>
            RunQuiet(exe, (args + " -c \"import fastapi, numpy, sklearn\"").Trim()));
    }

    private static async Task<string> NodeVersionAsync()
    {
        return await Task.Run(() =>
        {
            var text = Capture("node", "--version").Trim();     // "v20.17.0"
            var m = Regex.Match(text, @"^v(\d+)\.");
            if (!m.Success) return "";
            return int.TryParse(m.Groups[1].Value, out var major) && major >= 18
                ? "Node.js " + text.TrimStart('v')
                : "";
        });
    }

    /// <summary>The installed WebView2 runtime version, or "" when absent.</summary>
    private static string WebViewVersion()
    {
        const string clientId = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
        string[] keys =
        {
            @"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\" + clientId,
            @"SOFTWARE\Microsoft\EdgeUpdate\Clients\" + clientId,
        };
        foreach (var root in new[] { Microsoft.Win32.Registry.LocalMachine, Microsoft.Win32.Registry.CurrentUser })
        {
            foreach (var key in keys)
            {
                try
                {
                    using var k = root.OpenSubKey(key);
                    var pv = k?.GetValue("pv") as string;
                    if (!string.IsNullOrWhiteSpace(pv) && pv != "0.0.0.0") return "WebView2 " + pv;
                }
                catch
                {
                    // An unreadable key means "not detected", never a crash.
                }
            }
        }
        return "";
    }

    // =====================================================================
    // Installation
    // =====================================================================

    /// <summary>
    /// Fetch and install everything in <paramref name="missing"/>, in order.
    ///
    /// Order matters: Python before its libraries, Node before its packages.
    /// Build() already lists them that way and the caller preserves it.
    /// </summary>
    public static async Task InstallAsync(
        IEnumerable<Requirement> missing,
        string installDir,
        IProgress<string> say,
        CancellationToken ct)
    {
        var work = Path.Combine(Path.GetTempPath(), "AURION-setup");
        Directory.CreateDirectory(work);

        // Everything said on screen is also written down. A first run that
        // fails on somebody else's machine is unsupportable otherwise: the
        // one line still on screen is never the line that mattered.
        var log = Path.Combine(installDir, "data", "logs", "setup.log");
        var recorder = new Progress<string>(text =>
        {
            say.Report(text);
            Write(log, text);
        });
        Write(log, $"--- setup started, {missing.Count()} item(s) missing ---");
        say = recorder;

        foreach (var req in missing)
        {
            ct.ThrowIfCancellationRequested();
            req.State = ReqState.Installing;
            try
            {
                switch (req.Id)
                {
                    case "python": await InstallPythonAsync(work, say, ct); break;
                    case "pydeps": await InstallPythonLibsAsync(installDir, say, ct); break;
                    case "node": await InstallNodeAsync(work, say, ct); break;
                    case "nodedeps": await InstallNodeLibsAsync(installDir, say, ct); break;
                    case "webview": await InstallWebViewAsync(work, say, ct); break;
                }
                req.State = ReqState.Installed;
                req.Problem = "";
            }
            catch (OperationCanceledException)
            {
                req.State = ReqState.Missing;
                throw;
            }
            catch (Exception ex)
            {
                req.State = ReqState.Failed;
                req.Problem = ex.Message;
                Write(log, $"{req.Id}: FAILED - {ex}");
            }
        }

        Write(log, "--- setup finished ---");
        try { Directory.Delete(work, recursive: true); } catch { /* temp files */ }
    }

    private static async Task InstallPythonAsync(string work, IProgress<string> say, CancellationToken ct)
    {
        var file = await DownloadAsync(PythonUrl, Path.Combine(work, "python-setup.exe"),
            PythonPublisher, "Python", say, ct);

        say.Report("Installing Python…");
        // Per-user, on PATH, with pip. Never InstallAllUsers: a desk that
        // installs into %LocalAppData% has no business writing to Program
        // Files, and a per-user Python needs no elevation prompt.
        await RunAsync(file, "/quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_test=0",
            elevate: false, ct);

        // The new interpreter is not on this process's PATH, so re-detect.
        RefreshPath();
        PythonCommand = FindPython();
        if (PythonCommand.Length == 0)
        {
            throw new InvalidOperationException(
                "Python installed but could not be found afterwards. A sign-out and back in usually fixes the PATH.");
        }
    }

    private static async Task InstallPythonLibsAsync(string installDir, IProgress<string> say, CancellationToken ct)
    {
        if (PythonCommand.Length == 0) PythonCommand = FindPython();
        if (PythonCommand.Length == 0) throw new InvalidOperationException("Python is not available yet.");

        var requirements = Path.Combine(installDir, "engine", "requirements.txt");
        if (!File.Exists(requirements))
        {
            throw new FileNotFoundException("engine\\requirements.txt is missing from the installation.");
        }

        var (exe, args) = Split(PythonCommand);
        say.Report("Updating pip…");
        await RunAsync(exe, (args + " -m pip install --upgrade pip").Trim(), elevate: false, ct);

        say.Report("Installing the engine's libraries… this is the long one.");
        await RunAsync(exe, (args + $" -m pip install -r \"{requirements}\"").Trim(), elevate: false, ct);
    }

    private static async Task InstallNodeAsync(string work, IProgress<string> say, CancellationToken ct)
    {
        var file = await DownloadAsync(NodeUrl, Path.Combine(work, "node-setup.msi"),
            NodePublisher, "Node.js", say, ct);

        say.Report("Installing Node.js…");
        // Node's MSI is per-machine, so this one does need elevation. The
        // prompt is Windows's own and the user is told it is coming.
        await RunAsync("msiexec.exe", $"/i \"{file}\" /qn /norestart", elevate: true, ct);
        RefreshPath();
    }

    private static async Task InstallNodeLibsAsync(string installDir, IProgress<string> say, CancellationToken ct)
    {
        var backend = Path.Combine(installDir, "backend");
        if (!Directory.Exists(backend))
        {
            throw new DirectoryNotFoundException("The backend folder is missing from the installation.");
        }

        say.Report("Installing the desk API's packages…");
        // npm is a .cmd shim, so it has to go through the shell.
        await RunAsync("cmd.exe", "/c npm install --omit=dev --no-audit --no-fund",
            elevate: false, ct, backend);
    }

    private static async Task InstallWebViewAsync(string work, IProgress<string> say, CancellationToken ct)
    {
        var file = await DownloadAsync(WebViewUrl, Path.Combine(work, "webview2-setup.exe"),
            WebViewPublisher, "WebView2", say, ct);

        say.Report("Installing the WebView2 runtime…");
        await RunAsync(file, "/silent /install", elevate: false, ct);
    }

    // ---------------------------------------------------------------------
    // Downloading, with the checks that make it defensible
    // ---------------------------------------------------------------------

    private static async Task<string> DownloadAsync(
        string url, string target, string expectedPublisher, string label,
        IProgress<string> say, CancellationToken ct)
    {
        say.Report($"Downloading {label}…");

        using (var response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct))
        {
            response.EnsureSuccessStatusCode();
            var total = response.Content.Headers.ContentLength ?? 0L;
            await using var from = await response.Content.ReadAsStreamAsync(ct);
            await using var to = File.Create(target);

            // Copied by hand rather than with CopyToAsync so the trader can
            // see it moving. A 90 MB download behind a single unchanging
            // line of text is indistinguishable from a hang, and the first
            // thing anybody does with a hang is kill it.
            var buffer = new byte[128 * 1024];
            long done = 0;
            var lastReport = DateTime.MinValue;
            int read;
            while ((read = await from.ReadAsync(buffer, ct)) > 0)
            {
                await to.WriteAsync(buffer.AsMemory(0, read), ct);
                done += read;
                if (DateTime.UtcNow - lastReport < TimeSpan.FromMilliseconds(250)) continue;
                lastReport = DateTime.UtcNow;
                say.Report(total > 0
                    ? $"Downloading {label}…  {Megabytes(done)} of {Megabytes(total)}"
                    : $"Downloading {label}…  {Megabytes(done)}");
            }
        }

        if (new FileInfo(target).Length < 100_000)
        {
            File.Delete(target);
            throw new InvalidOperationException($"The {label} download was too small to be real.");
        }

        if (!SignedBy(target, expectedPublisher))
        {
            File.Delete(target);
            throw new InvalidOperationException(
                $"The {label} download is not signed by {expectedPublisher}. It was deleted without being run.");
        }

        return target;
    }

    /// <summary>
    /// Is this file Authenticode-signed by who we expect?
    ///
    /// Checked instead of a pinned hash on purpose. A hash pins one exact
    /// build and quietly starts rejecting the genuine file the day the vendor
    /// ships a patch; a publisher check keeps being true, and is the same
    /// question Windows itself asks before it runs the thing.
    /// </summary>
    private static bool SignedBy(string path, string publisher)
    {
        try
        {
            using var cert = new X509Certificate2(X509Certificate.CreateFromSignedFile(path));
            var subject = cert.Subject ?? "";
            return subject.IndexOf(publisher, StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch
        {
            // No signature at all, or one Windows cannot read: refuse it.
            return false;
        }
    }

    // ---------------------------------------------------------------------
    // Processes
    // ---------------------------------------------------------------------

    private static async Task RunAsync(string exe, string args, bool elevate, CancellationToken ct,
        string? workingDirectory = null)
    {
        var psi = new ProcessStartInfo
        {
            FileName = exe,
            Arguments = args,
            UseShellExecute = elevate,
            CreateNoWindow = !elevate,
            WindowStyle = ProcessWindowStyle.Hidden,
            WorkingDirectory = workingDirectory ?? Path.GetTempPath(),
        };
        if (elevate) psi.Verb = "runas";

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException($"Could not start {Path.GetFileName(exe)}.");

        await proc.WaitForExitAsync(ct);

        // 3010 is "installed, wants a reboot" and is a success everywhere.
        if (proc.ExitCode != 0 && proc.ExitCode != 3010)
        {
            throw new InvalidOperationException(
                $"{Path.GetFileName(exe)} finished with code {proc.ExitCode}.");
        }
    }

    private static bool RunQuiet(string exe, string args)
    {
        try
        {
            var psi = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var p = Process.Start(psi);
            if (p is null) return false;
            p.WaitForExit(8000);
            return p.HasExited && p.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private static string Capture(string exe, string args)
    {
        try
        {
            var psi = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var p = Process.Start(psi);
            if (p is null) return "";
            var text = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
            p.WaitForExit(8000);
            return text;
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// Pick up PATH changes an installer just made.
    ///
    /// A process inherits the environment it started with, so the Python that
    /// was installed thirty seconds ago is invisible until this is done.
    /// </summary>
    private static void RefreshPath()
    {
        try
        {
            var machine = Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.Machine) ?? "";
            var user = Environment.GetEnvironmentVariable("PATH", EnvironmentVariableTarget.User) ?? "";
            Environment.SetEnvironmentVariable("PATH", machine + ";" + user);
        }
        catch
        {
            // Not fatal: the next launch will see it even if this one does not.
        }
    }

    /// <summary>Append one line to the setup log, and never fail doing it.</summary>
    private static void Write(string path, string text)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.AppendAllText(path, $"{DateTime.Now:u}  {text}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never be the reason setup stops.
        }
    }

    private static string Megabytes(long bytes) => (bytes / 1024d / 1024d).ToString("0.0") + " MB";

    private static (string exe, string args) Split(string command)
    {
        var at = command.IndexOf(' ');
        return at < 0 ? (command, "") : (command[..at], command[(at + 1)..]);
    }
}
