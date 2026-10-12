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
    private const string PythonFullVersion = "3.12.7";
    private const string PythonExeName = "python-" + PythonFullVersion + "-amd64.exe";
    private const string PythonUrl =
        "https://www.python.org/ftp/python/" + PythonFullVersion + "/" + PythonExeName;
    private const string PythonPublisher = "Python Software Foundation";

    // ---------------------------------------------------------------------
    // Bundled runtimes
    //
    // installer\tools\fetch-vendor.ps1 downloads these on the build machine
    // and stage.ps1 puts them in the payload, so a customer's machine
    // installs AURION without reaching the network at all. That machine is
    // the worst possible place to be discovering a proxy, an expired root
    // certificate or a blocked vendor domain: nobody can log into it and the
    // only symptom is a desk that does not start.
    //
    // The filenames are a contract with fetch-vendor.ps1. A test keeps them
    // in step. When the folder is absent - a build that skipped the bundle -
    // every one of these falls back to downloading, exactly as before.
    // ---------------------------------------------------------------------

    /// <summary>A file shipped in the payload, or "" when it was not bundled.</summary>
    private static string Bundled(string installDir, string name)
    {
        try
        {
            var path = Path.Combine(installDir, "vendor", name);
            return File.Exists(path) ? path : "";
        }
        catch
        {
            return "";
        }
    }

    // Node arrives as the official zip, not the MSI, and is unpacked into the
    // installation folder.
    //
    // The MSI is per-machine: it raises a UAC prompt that a trader running a
    // per-user install was never warned about, fails outright on a managed
    // laptop, and - the reason this was rewritten - puts node.exe somewhere
    // only a PATH refresh can find. A zip under the install folder needs no
    // elevation, no PATH, and no administrator; it is found by absolute path
    // and it leaves with the uninstall.
    //
    // A zip carries no Authenticode signature, so it is verified against the
    // SHA-256 published alongside it on nodejs.org over https instead.
    private const string NodeVersion = "v20.17.0";
    private const string NodeZipName = "node-" + NodeVersion + "-win-x64.zip";
    private const string NodeZipUrl = "https://nodejs.org/dist/" + NodeVersion + "/" + NodeZipName;
    private const string NodeSumsUrl = "https://nodejs.org/dist/" + NodeVersion + "/SHASUMS256.txt";

    // Microsoft's evergreen bootstrapper: a tiny stub that fetches the current
    // runtime itself. Deliberately not version-pinned - that is the supported
    // way to install it and the only link Microsoft keeps stable.
    private const string WebViewUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
    private const string WebViewPublisher = "Microsoft Corporation";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(10) };

    /// <summary>The Python interpreter found by the last inspection.</summary>
    public static string PythonCommand { get; private set; } = "";

    /// <summary>The node.exe found by the last inspection, absolute when known.</summary>
    public static string NodeCommand { get; private set; } = "";

    /// <summary>AURION's own copy of Node, if it has been unpacked.</summary>
    public static string PrivateNode(string installDir) =>
        Path.Combine(installDir, "runtime", "node", "node.exe");

    /// <summary>
    /// AURION's own Python, if it has been installed.
    ///
    /// Private on purpose, and it is the whole answer to "I want to upgrade
    /// the system Python". The engine is pinned to NumPy 1.26.4 because it
    /// is the last official Windows wheel that does not require x86-64-v2,
    /// and that wheel exists only for CPython 3.9 to 3.12. Depending on
    /// whatever Python the machine happens to have meant that upgrading it -
    /// an ordinary, sensible thing to do - silently broke the engine.
    ///
    /// So AURION brings its own, inside its own folder, on PATH for nobody.
    /// The machine's Python can be 3.15, or absent, and neither matters.
    /// </summary>
    public static string PrivatePython(string installDir) =>
        Path.Combine(installDir, "runtime", "python", "python.exe");

    /// <summary>Everything AURION needs, in the order it is shown.</summary>
    public static List<Requirement> Build() => new()
    {
        new Requirement
        {
            Id = "python",
            Title = "Python 3.12",
            Why = "Runs the engine. Installed inside AURION, so upgrading the machine's own Python cannot break it.",
            Source = "python.org (into AURION's folder, no administrator)",
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
            Source = "nodejs.org (unpacked into AURION's own folder, no administrator)",
            Size = "30 MB",
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
        var python = FindPython(installDir);
        PythonCommand = python;
        NodeCommand = FindNode(installDir);

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
                    var node = await NodeVersionAsync(installDir);
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

        // Hand the launcher absolute paths. start-aurion.cmd runs in a console
        // whose environment was captured before any of this happened, so PATH
        // is the one thing it cannot trust.
        WriteRuntimeEnv(installDir);
    }

    /// <summary>
    /// Record the interpreters where the launcher can read them.
    ///
    /// data\runtime.env is two KEY=value lines, parsed by start-aurion.cmd with
    /// a plain for /f. It is a cache, never a requirement: every consumer falls
    /// back to searching when a path in here no longer exists.
    /// </summary>
    public static void WriteRuntimeEnv(string installDir)
    {
        try
        {
            var lines = new List<string>();
            var py = AbsolutePython();
            if (py.Length > 0) lines.Add("PYTHON=" + py);
            if (NodeCommand.Length > 0 && File.Exists(NodeCommand)) lines.Add("NODE=" + NodeCommand);
            if (lines.Count == 0) return;

            var dir = Path.Combine(installDir, "data");
            Directory.CreateDirectory(dir);
            File.WriteAllLines(Path.Combine(dir, "runtime.env"), lines);
        }
        catch
        {
            // A cache that could not be written costs a PATH lookup, nothing more.
        }
    }

    /// <summary>The full path of the interpreter behind PythonCommand, or "".</summary>
    private static string AbsolutePython()
    {
        if (PythonCommand.Length == 0) return "";
        var (exe, args) = Split(PythonCommand);
        var text = Capture(exe, (args + " -c \"import sys; print(sys.executable)\"").Trim()).Trim();
        var first = text.Split('\n').FirstOrDefault()?.Trim() ?? "";
        return first.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && File.Exists(first) ? first : "";
    }

    private static void Settle(Requirement req, bool ok, string found, string problem)
    {
        req.State = ok ? ReqState.Present : ReqState.Missing;
        req.Found = ok ? found : "";
        req.Problem = ok ? "" : problem;
    }

    /// <summary>
    /// The interpreter AURION should use: its own first, the machine's only
    /// as a fallback for installations that predate the private runtime.
    /// </summary>
    private static string FindPython(string installDir)
    {
        var mine = PrivatePython(installDir);
        if (File.Exists(mine) && PythonVersionOf(Quoted(mine)).Length > 0) return Quoted(mine);

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

    /// <summary>Quote a path so Split() hands it back in one piece.</summary>
    private static string Quoted(string path) => "\"" + path + "\"";

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

    /// <summary>
    /// node.exe, by absolute path wherever possible.
    ///
    /// Order: AURION's own copy, then PATH, then the two places the official
    /// installers use. Asking PATH alone is what left a freshly prepared
    /// machine insisting Node was missing - this process inherited its
    /// environment before Node existed and nothing it did could change that.
    /// </summary>
    private static string FindNode(string installDir)
    {
        var mine = PrivateNode(installDir);
        if (File.Exists(mine)) return mine;

        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (dir.Trim().Length == 0) continue;
            try
            {
                var candidate = Path.Combine(dir.Trim(), "node.exe");
                if (File.Exists(candidate)) return candidate;
            }
            catch
            {
                // An unparseable PATH entry is not an error, it is just not Node.
            }
        }

        string[] usual =
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs", "nodejs", "node.exe"),
        };
        return usual.FirstOrDefault(File.Exists) ?? "";
    }

    private static async Task<string> NodeVersionAsync(string installDir)
    {
        return await Task.Run(() =>
        {
            var exe = FindNode(installDir);
            if (exe.Length == 0) return "";
            NodeCommand = exe;

            var text = Capture(exe, "--version").Trim();        // "v20.17.0"
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
                    case "python": await InstallPythonAsync(work, installDir, say, ct); break;
                    case "pydeps": await InstallPythonLibsAsync(installDir, say, ct); break;
                    case "node": await InstallNodeAsync(work, installDir, say, ct); break;
                    case "nodedeps": await InstallNodeLibsAsync(installDir, say, ct); break;
                    case "webview": await InstallWebViewAsync(work, installDir, say, ct); break;
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

    private static async Task InstallPythonAsync(string work, string installDir, IProgress<string> say, CancellationToken ct)
    {
        var file = Bundled(installDir, PythonExeName);
        if (file.Length > 0)
        {
            say.Report("Using the Python that ships with AURION…");
            // Still verified. It came out of our own MSI, but the check costs
            // nothing and a bundle is only as good as the thing that made it.
            if (!SignedBy(file, PythonPublisher))
            {
                throw new InvalidOperationException(
                    "The bundled Python installer is not signed by " + PythonPublisher + ".");
            }
        }
        else
        {
            file = await DownloadAsync(PythonUrl, Path.Combine(work, "python-setup.exe"),
                PythonPublisher, "Python", say, ct);
        }

        var target = Path.Combine(installDir, "runtime", "python");
        say.Report("Installing Python into AURION's own folder…");

        // Everything here is "ours, and only ours".
        //
        // TargetDir puts the interpreter inside the installation, so the
        // engine's pinned NumPy cannot be broken by someone upgrading the
        // machine's Python - which is an ordinary thing to do and used to
        // be fatal. PrependPath=0 and AssociateFiles=0 because a trading
        // desk has no business owning the PATH or the .py extension.
        // Include_launcher=0 so py.exe in C:\Windows is left exactly as it
        // was found. No elevation is needed for any of it.
        await RunAsync(file,
            "/quiet InstallAllUsers=0 TargetDir=\"" + target + "\" " +
            "PrependPath=0 AssociateFiles=0 Shortcuts=0 " +
            "Include_launcher=0 InstallLauncherAllUsers=0 " +
            "Include_pip=1 Include_test=0 Include_doc=0 Include_tcltk=0",
            elevate: false, ct);

        var mine = PrivatePython(installDir);
        if (File.Exists(mine))
        {
            PythonCommand = Quoted(mine);
            WriteRuntimeEnv(installDir);
            say.Report("Python is ready, inside AURION.");
            return;
        }

        // The installer did not put it where it was told. Fall back to
        // whatever it did produce rather than failing outright.
        RefreshPath();
        PythonCommand = FindPython(installDir);
        if (PythonCommand.Length == 0)
        {
            throw new InvalidOperationException(
                "Python was installed but could not be found afterwards. Expected it at " + mine + ".");
        }
    }

    private static async Task InstallPythonLibsAsync(string installDir, IProgress<string> say, CancellationToken ct)
    {
        if (PythonCommand.Length == 0) PythonCommand = FindPython(installDir);
        if (PythonCommand.Length == 0) throw new InvalidOperationException("Python is not available yet.");

        var requirements = Path.Combine(installDir, "engine", "requirements.txt");
        if (!File.Exists(requirements))
        {
            throw new FileNotFoundException("engine\\requirements.txt is missing from the installation.");
        }

        var (exe, args) = Split(PythonCommand);
        say.Report("Updating pip…");
        try
        {
            await RunAsync(exe, (args + " -m pip install --upgrade pip").Trim(), elevate: false, ct);
        }
        catch (Exception ex)
        {
            // Upgrading pip is a nicety. On a machine with no network it
            // fails, and failing the install over it would throw away a
            // perfectly good offline bundle.
            say.Report("pip could not be updated (" + ex.Message + ") - carrying on.");
        }

        // Wheels bundled by fetch-vendor.ps1 mean no PyPI, no proxy, no
        // ninety-megabyte download on somebody else's laptop.
        var wheels = Path.Combine(installDir, "vendor", "wheels");
        if (Directory.Exists(wheels) && Directory.GetFiles(wheels, "*.whl").Length > 0)
        {
            say.Report("Installing the engine's libraries from the copies that ship with AURION…");
            await RunAsync(exe,
                (args + $" -m pip install --no-index --find-links \"{wheels}\" -r \"{requirements}\"").Trim(),
                elevate: false, ct);
            return;
        }

        say.Report("Installing the engine's libraries… this is the long one.");
        await RunAsync(exe, (args + $" -m pip install -r \"{requirements}\"").Trim(), elevate: false, ct);
    }

    /// <summary>
    /// Unpack Node into the installation folder. No installer, no elevation.
    ///
    /// Nothing outside AURION's own directory is touched, so there is no UAC
    /// prompt to decline, no PATH to go stale, and nothing left behind when
    /// AURION is uninstalled.
    /// </summary>
    private static async Task InstallNodeAsync(string work, string installDir, IProgress<string> say, CancellationToken ct)
    {
        var zip = Bundled(installDir, NodeZipName);
        if (zip.Length > 0)
        {
            say.Report("Using the Node.js that ships with AURION…");
            // fetch-vendor.ps1 bundles nodejs.org's checksum list next to the
            // zip precisely so this can still be checked with no network.
            var sums = Bundled(installDir, "SHASUMS256.txt");
            if (sums.Length > 0) VerifyAgainstSums(zip, await File.ReadAllTextAsync(sums, ct), NodeZipName);
        }
        else
        {
            zip = Path.Combine(work, NodeZipName);
            // The empty publisher is deliberate: a zip has no Authenticode
            // signature, and the line below is what replaces that check.
            await DownloadAsync(NodeZipUrl, zip, "", "Node.js", say, ct);

            say.Report("Checking the Node.js download…");
            await VerifyAgainstPublishedSumAsync(zip, NodeSumsUrl, NodeZipName, ct);
        }

        say.Report("Unpacking Node.js…");
        var runtime = Path.Combine(installDir, "runtime");
        var target = Path.Combine(runtime, "node");
        var staging = Path.Combine(runtime, "node-new");

        await Task.Run(() =>
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
            Directory.CreateDirectory(runtime);
            System.IO.Compression.ZipFile.ExtractToDirectory(zip, staging);
        }, ct);

        // The zip holds a single node-vX.Y.Z-win-x64 folder; promote its
        // contents so node.exe sits exactly where PrivateNode() says it does.
        var inner = Directory.GetDirectories(staging).FirstOrDefault() ?? staging;
        if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
        Directory.Move(inner, target);
        try { Directory.Delete(staging, recursive: true); } catch { /* already empty */ }

        var node = PrivateNode(installDir);
        if (!File.Exists(node))
        {
            throw new InvalidOperationException("Node.js unpacked but node.exe is not where it should be.");
        }
        NodeCommand = node;
        WriteRuntimeEnv(installDir);
        say.Report("Node.js is ready.");
    }

    /// <summary>
    /// Verify a download against the checksum file the vendor publishes next
    /// to it.
    ///
    /// A zip has no Authenticode signature, so the publisher check that
    /// guards the .exe downloads cannot be used. The checksum list is fetched
    /// over https from the same origin and is not pinned, so it keeps being
    /// correct when the pinned version is bumped.
    /// </summary>
    private static async Task VerifyAgainstPublishedSumAsync(
        string file, string sumsUrl, string name, CancellationToken ct)
    {
        var sums = await Http.GetStringAsync(sumsUrl, ct);
        try
        {
            VerifyAgainstSums(file, sums, name);
        }
        catch
        {
            // Only a *downloaded* file is deleted on a bad checksum. The
            // bundled copy lives in the installation and deleting it would
            // turn a verification failure into a broken install that needs a
            // repair; the exception is enough to stop it being used.
            File.Delete(file);
            throw;
        }
    }

    /// <summary>
    /// The comparison itself, so the bundled path can reuse it.
    /// Throws without touching the file - see the caller above.
    /// </summary>
    private static void VerifyAgainstSums(string file, string sums, string name)
    {
        var wanted = sums
            .Split('\n')
            .Select(line => line.Trim())
            .FirstOrDefault(line => line.EndsWith(" " + name, StringComparison.OrdinalIgnoreCase)
                                 || line.EndsWith("*" + name, StringComparison.OrdinalIgnoreCase));
        if (wanted is null)
        {
            throw new InvalidOperationException($"{name} is not listed in the vendor's checksum file.");
        }

        var expected = wanted.Split(' ')[0].Trim();
        string actual;
        using (var stream = File.OpenRead(file))
        {
            actual = Convert.ToHexString(
                System.Security.Cryptography.SHA256.HashData(stream)).ToLowerInvariant();
        }

        if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException(
                $"{name} does not match the checksum published for it. It was not used.");
        }
    }

    private static async Task InstallNodeLibsAsync(string installDir, IProgress<string> say, CancellationToken ct)
    {
        var backend = Path.Combine(installDir, "backend");
        if (!Directory.Exists(backend))
        {
            throw new DirectoryNotFoundException("The backend folder is missing from the installation.");
        }

        if (NodeCommand.Length == 0 || !File.Exists(NodeCommand)) NodeCommand = FindNode(installDir);
        if (NodeCommand.Length == 0) throw new InvalidOperationException("Node.js is not available yet.");

        say.Report("Installing the desk API's packages…");

        // npm is run as a script through node, by absolute path, rather than
        // as the npm.cmd shim through the shell: the shim is only reachable
        // via a PATH this process may not have, and AURION's own copy of Node
        // is deliberately not on PATH at all.
        var cli = Path.Combine(Path.GetDirectoryName(NodeCommand)!,
            "node_modules", "npm", "bin", "npm-cli.js");
        if (File.Exists(cli))
        {
            await RunAsync(NodeCommand, $"\"{cli}\" install --omit=dev --no-audit --no-fund",
                elevate: false, ct, backend);
        }
        else
        {
            // A system-wide Node installed by the MSI keeps npm on PATH.
            await RunAsync("cmd.exe", "/c npm install --omit=dev --no-audit --no-fund",
                elevate: false, ct, backend);
        }
    }

    private static async Task InstallWebViewAsync(string work, string installDir, IProgress<string> say, CancellationToken ct)
    {
        var file = Bundled(installDir, "MicrosoftEdgeWebview2Setup.exe");
        if (file.Length > 0)
        {
            say.Report("Using the WebView2 installer that ships with AURION…");
            if (!SignedBy(file, WebViewPublisher))
            {
                throw new InvalidOperationException(
                    "The bundled WebView2 installer is not signed by " + WebViewPublisher + ".");
            }
        }
        else
        {
            file = await DownloadAsync(WebViewUrl, Path.Combine(work, "webview2-setup.exe"),
                WebViewPublisher, "WebView2", say, ct);
        }

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

        // An empty publisher means the caller verifies integrity another way
        // (see VerifyAgainstPublishedSumAsync); it never means "unchecked".
        if (expectedPublisher.Length > 0 && !SignedBy(target, expectedPublisher))
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

    /// <summary>
    /// Break "py -3.12" into a program and its arguments.
    ///
    /// A quoted path is taken whole: the private interpreter lives under
    /// %LocalAppData%\Programs\AURION, and splitting that on its first
    /// space would hand the compiler half a directory name.
    /// </summary>
    private static (string exe, string args) Split(string command)
    {
        if (command.StartsWith('"'))
        {
            var close = command.IndexOf('"', 1);
            if (close > 0)
            {
                return (command[1..close], command[(close + 1)..].Trim());
            }
        }

        var at = command.IndexOf(' ');
        return at < 0 ? (command, "") : (command[..at], command[(at + 1)..]);
    }
}
