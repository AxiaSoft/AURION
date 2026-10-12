using System.Diagnostics;
using System.Drawing;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Aurion.Window;

/// <summary>
/// The AURION desk in a real Windows window.
///
/// Responsibilities, deliberately kept to the minimum:
///   1. make sure the desk is running - by calling the application's own
///      start-aurion.cmd, never by re-implementing what it does;
///   2. show it;
///   3. explain clearly when something goes wrong.
/// </summary>
internal sealed class AppWindow : Form
{
    private const string DeskUrl = "http://127.0.0.1:8080";
    private const string HealthUrl = DeskUrl + "/api/health";

    // Opening size. Deliberately a window, never maximised: traders keep the
    // desk next to MetaTrader. After the first run the size the user chose is
    // restored instead (see LoadPlacement / SavePlacement).
    private const int DefaultWidth = 1270;
    private const int DefaultHeight = 720;

    private static readonly TimeSpan StartupBudget = TimeSpan.FromMinutes(3);

    private readonly WebView2 _view = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly SplashPanel _splash;

    private readonly string _installDir = AppContext.BaseDirectory.TrimEnd('\\');

    /// <summary>
    /// The channel for desktop notifications.
    ///
    /// A NotifyIcon balloon rather than a WinRT toast on purpose: WinRT
    /// notifications need a registered AppUserModelID backed by a shortcut and
    /// a packaged identity, which a per-user MSI that installs into
    /// %LocalAppData% cannot guarantee. A balloon works everywhere, needs no
    /// registration, and can be clicked - which is all this has to do.
    /// </summary>
    private readonly NotifyIcon _tray = new() { Visible = false, Text = "AURION" };

    /// <summary>Set by the last toast, so a click knows which chart to open.</summary>
    private string _pendingSymbol = "";
    private string _pendingTimeframe = "";
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(2) };

    /// <summary>When true the window only runs the first-run check, then closes.</summary>
    private readonly bool _setupOnly;

    public AppWindow(bool setupOnly = false)
    {
        _setupOnly = setupOnly;

        // Scale with the display.
        //
        // app.manifest declares PerMonitorV2, but every control here is
        // positioned in raw pixels against fonts in points, and nothing told
        // WinForms to scale the layout. On a laptop running at 125% or 150%
        // - which is the default on most machines sold in the last decade -
        // the panels were laid out for 96 DPI and drawn on a display that is
        // not: cramped, clipped and overlapping. It did not look like a
        // window that had failed to scale, it looked like one that had not
        // finished loading, which is exactly how it was reported.
        AutoScaleMode = AutoScaleMode.Dpi;

        Text = setupOnly ? "AURION setup" : "AURION";
        BackColor = Color.FromArgb(0x06, 0x07, 0x0B);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(DefaultWidth, DefaultHeight);
        MinimumSize = new Size(900, 600);
        WindowState = FormWindowState.Normal;
        Icon = LoadIcon();

        _splash = new SplashPanel(SplashMark()) { Status = "Starting AURION…" };
        // The browser control is deliberately NOT added yet. On a machine
        // with no WebView2 runtime, giving it a window handle can throw -
        // and that would take the whole window down before the screen that
        // exists to explain the problem has had a chance to appear. It is
        // added in ShowDeskAsync, once the runtime is known to be there.
        Controls.Add(_splash);

        LoadPlacement();
        Shown += async (_, _) => await BootAsync();
        FormClosing += (_, _) => { SavePlacement(); _tray.Visible = false; };

        _tray.Icon = Icon ?? SystemIcons.Application;
        _tray.BalloonTipClicked += (_, _) => OpenSignalFromToast();
        _tray.Click += (_, _) => { if (!Visible || WindowState == FormWindowState.Minimized) RaiseWindow(); };

        // The desk needs to know whether it can be seen: a toast for a signal
        // the trader is already looking at is noise, and the Page Visibility
        // API does not fire for a minimised window - only for a hidden tab.
        Resize += (_, _) => ReportVisibility();
        Activated += (_, _) => ReportVisibility();
        Deactivate += (_, _) => ReportVisibility();
    }

    // ----------------------------------------------------------------- boot

    private async Task BootAsync()
    {
        // Nothing is worth starting until the machine can run it. On a
        // prepared desk this costs a few hundred milliseconds and nobody
        // ever sees it; on a bare one it is the difference between an
        // explanation and three minutes of a bar that was never going to
        // finish.
        var ready = await EnsurePrerequisitesAsync();
        if (_setupOnly) { Close(); return; }
        if (!ready) return;

        if (await DeskIsAnsweringAsync())
        {
            _splash.Status = "Connecting to the desk…";
            _splash.Progress = 0.85f;
        }
        else
        {
            _splash.Status = "Starting the engine…";

            // Everything written to the logs from here on belongs to this
            // run. Without these marks the failure box quotes whatever
            // happened to be at the end of a file that has been appended to
            // since September, which is worse than saying nothing.
            MarkLogs();

            var launcher = StartDesk();
            if (launcher is null) return;

            var clock = Stopwatch.StartNew();
            while (clock.Elapsed < StartupBudget)
            {
                await Task.Delay(500);

                // A launcher that exits non-zero has usually worked out what
                // is wrong and written it down, and waiting out the rest of
                // three minutes only delays the news.
                //
                // Usually, not always. start-aurion.cmd gives the desk 45
                // seconds and then exits 1 itself - and on a first run, the
                // engine's first import of numpy and scikit-learn alone can
                // take longer than that. Treating that exit as fatal turned
                // a slow start into a failure, which is a worse bug than the
                // one the fail-fast was added to fix. So an early exit is
                // believed and a late one is not: by thirty seconds nothing
                // has been imported yet, and an exit that soon means a
                // missing prerequisite or a broken tree.
                if (launcher.HasExited && launcher.ExitCode != 0
                    && clock.Elapsed < TimeSpan.FromSeconds(30))
                {
                    await Task.Delay(1500);              // let the logs flush
                    if (await DeskIsAnsweringAsync()) break;
                    ShowStartupFailure(Diagnosis(launcher.ExitCode));
                    return;
                }

                // Honest progress: the elapsed share of the budget, capped well
                // short of full, because reaching 100% before the desk answers
                // would be a lie. The bar completes when the desk really does.
                var share = (float)(clock.Elapsed.TotalSeconds / StartupBudget.TotalSeconds);
                _splash.Progress = Math.Min(0.8f, 0.05f + share * 2.2f);
                _splash.Status = clock.Elapsed.TotalSeconds < 12
                    ? "Starting the engine…"
                    : $"Waiting for the desk…  {clock.Elapsed.Seconds + clock.Elapsed.Minutes * 60}s";

                if (await DeskIsAnsweringAsync()) break;
            }

            if (!await DeskIsAnsweringAsync())
            {
                var code = launcher.HasExited ? launcher.ExitCode : (int?)null;
                ShowStartupFailure(Diagnosis(code));
                return;
            }
        }

        _splash.Status = "Loading the desk…";
        _splash.Progress = 0.92f;
        await ShowDeskAsync();
    }

    /// <summary>
    /// Make this machine able to run AURION, on the loading screen, now.
    ///
    /// This is the whole first-run experience and it is deliberately not a
    /// wizard. A trader who has just run an installer and ticked "launch
    /// AURION" has already said what they want; asking them a second time,
    /// in a window that may not even have focus, is how a bare machine ended
    /// up installing nothing and timing out three minutes later.
    ///
    /// So: look, install, look again - all of it narrated on the splash,
    /// exactly the way start-aurion.cmd does it from a console. The setup
    /// panel still exists, but it is now the *failure* surface. It appears
    /// only when something could not be installed and there is a decision
    /// worth putting in front of somebody.
    /// </summary>
    /// <returns>false when the window is closing and boot should stop.</returns>
    private async Task<bool> EnsurePrerequisitesAsync()
    {
        // A desk that is already answering has, by definition, everything it
        // needs - skip the question entirely on a warm start. Unless the
        // trader asked for the check on purpose, in which case show it.
        if (!_setupOnly && await DeskIsAnsweringAsync()) return true;

        _splash.Visible = true;
        _splash.BringToFront();
        _splash.Status = "Checking what this machine has\u2026";
        _splash.Progress = 0.04f;

        // Checking whether numpy and scikit-learn import is the slowest
        // thing that happens before the desk appears, and on a first run it
        // is slow for a reason nobody can see: Python is compiling several
        // thousand files to bytecode. Left silent it reads as a hang on the
        // one launch where the machine is doing the most work.
        var checking = new Progress<string>(text => _splash.Status = text + "\u2026");

        var items = Prerequisites.Build();
        try
        {
            await Prerequisites.InspectAsync(items, _installDir, checking);
        }
        catch (Exception ex)
        {
            // Detection itself failing is not a reason to stop: the launcher
            // runs the same checks again and can still get there.
            Note("the prerequisite check could not complete: " + ex);
        }

        var missing = items.Where(r => r.State is ReqState.Missing or ReqState.Failed).ToList();

        if (missing.Count == 0)
        {
            if (!_setupOnly) return true;
            _splash.Status = "Everything AURION needs is already installed.";
            _splash.Progress = 1f;
            await Task.Delay(1800);
            return true;
        }

        // ------------------------------------------------------------------
        // Install, right here, without being asked
        // ------------------------------------------------------------------
        Note("missing on this machine: " + string.Join(", ", missing.Select(r => r.Id)));
        _splash.Status = "Installing " + Readable(missing) + "\u2026";
        _splash.Progress = 0.08f;

        // Not disposed on purpose: the install runs on continuations that can
        // outlive this scope, and a cancelled token source is cheap.
        var cancel = new CancellationTokenSource();
        FormClosing += (_, _) => cancel.Cancel();

        // Progress is derived from how many requirements the machine actually
        // has now, never from a guess about how long a download will take.
        var say = new Progress<string>(text =>
        {
            _splash.Status = text;
            var settled = items.Count(r => r.State is ReqState.Present or ReqState.Installed);
            _splash.Progress = 0.08f + 0.62f * settled / Math.Max(1, items.Count);
        });

        var trouble = "";
        try
        {
            await Prerequisites.InstallAsync(missing, _installDir, say, cancel.Token);

            // Ask the machine again rather than trusting the installers: what
            // matters is whether the thing is now detectable, not whether a
            // setup program said it succeeded.
            _splash.Status = "Checking again\u2026";
            await Prerequisites.InspectAsync(items, _installDir, checking);
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (Exception ex)
        {
            trouble = ex.Message;
            Note("setup stopped: " + ex);
        }

        if (items.All(r => r.State is ReqState.Present or ReqState.Installed))
        {
            _splash.Status = "Ready. Starting the desk\u2026";
            _splash.Progress = 0.75f;
            await Task.Delay(600);
            return true;
        }

        // ------------------------------------------------------------------
        // Only now is there anything worth interrupting somebody for
        // ------------------------------------------------------------------
        return await ShowSetupPanelAsync(items, cancel, trouble);
    }

    /// <summary>"Python 3.12, Node.js 20 and 2 more things".</summary>
    private static string Readable(List<Requirement> missing)
    {
        var names = missing.Select(r => r.Title).ToList();
        if (names.Count == 1) return names[0];
        if (names.Count == 2) return names[0] + " and " + names[1];
        return string.Join(", ", names.Take(names.Count - 1)) + " and " + names[^1];
    }

    /// <summary>
    /// The screen for when automatic setup did not get there.
    ///
    /// It says what is still missing and why, and offers to try again. This
    /// is no longer part of a normal first run - reaching it means something
    /// needs a human.
    /// </summary>
    private async Task<bool> ShowSetupPanelAsync(
        List<Requirement> items, CancellationTokenSource cancel, string trouble)
    {
        var setup = new SetupPanel(items);
        var done = new TaskCompletionSource<bool>();

        setup.SkipRequested += (_, _) => done.TrySetResult(true);
        setup.CancelRequested += (_, _) => cancel.Cancel();
        setup.InstallRequested += async (_, _) =>
        {
            // A retry needs a token that has not already been cancelled.
            var retry = new CancellationTokenSource();
            setup.Working(true);
            var say = new Progress<string>(setup.Say);
            try
            {
                var still = items.Where(r => r.State is ReqState.Missing or ReqState.Failed).ToList();
                await Prerequisites.InstallAsync(still, _installDir, say, retry.Token);

                setup.Say("Checking again\u2026");
                await Prerequisites.InspectAsync(items, _installDir, say);
                setup.Render();

                if (items.All(r => r.State is ReqState.Present or ReqState.Installed))
                {
                    setup.Say("Ready. Starting the desk\u2026");
                    await Task.Delay(700);
                    done.TrySetResult(true);
                    return;
                }
                setup.Say("Some of it did not install. The details are on the rows above.");
            }
            catch (OperationCanceledException)
            {
                setup.Say("Stopped.");
            }
            catch (Exception ex)
            {
                setup.Say("Setup stopped: " + ex.Message);
            }
            finally
            {
                setup.Working(false);
                setup.Render();
            }
        };

        _splash.Visible = false;
        Controls.Add(setup);
        setup.BringToFront();
        setup.Render();
        setup.Say(trouble.Length > 0
            ? "Automatic setup stopped: " + trouble
            : "Some of this could not be installed automatically.");

        FormClosing += (_, _) => done.TrySetResult(false);
        var proceed = await done.Task;

        Controls.Remove(setup);
        setup.Dispose();
        if (!proceed) return false;

        _splash.Visible = true;
        _splash.BringToFront();
        _splash.Status = "Starting AURION\u2026";
        return true;
    }

    /// <summary>One line into data\logs\window.log, and never fail writing it.</summary>
    private void Note(string text)
    {
        try
        {
            var log = Path.Combine(_installDir, "data", "logs", "window.log");
            Directory.CreateDirectory(Path.GetDirectoryName(log)!);
            File.AppendAllText(log, $"{DateTime.Now:u}  {text}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never be the reason a first run stops.
        }
    }

    /// <summary>
    /// Runs the application's own launcher, hidden, and lets it do its job.
    /// </summary>
    /// <returns>The launcher process, or null when it could not be started.</returns>
    private Process? StartDesk()
    {
        var starter = Path.Combine(_installDir, "start-aurion.cmd");
        if (!File.Exists(starter))
        {
            MessageBox.Show(this,
                $"AURION is not installed correctly:\n\n{starter} is missing.\n\n" +
                "Use Settings > Apps > AURION > Modify > Repair to restore it.",
                "AURION", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return null;
        }

        var psi = new ProcessStartInfo
        {
            FileName = starter,
            WorkingDirectory = _installDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };

        // The desk lives in this window, so tell start-aurion.cmd not to open a
        // browser tab as well. The variable is honoured by the application's own
        // script; when it is absent the script behaves exactly as it always did.
        psi.Environment["AURION_NO_BROWSER"] = "1";

        // A child inherits this process's environment, and this process's
        // environment was captured before setup installed anything. Rebuild
        // PATH from the registry so the launcher sees the Python that was
        // installed four seconds ago, and add AURION's own Node to it.
        psi.Environment["PATH"] = CurrentPath();

        try
        {
            return Process.Start(psi);
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"AURION could not be started:\n\n{ex.Message}",
                "AURION", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return null;
        }
    }

    /// <summary>PATH as the registry has it now, plus AURION's private Node.</summary>
    private string CurrentPath()
    {
        var parts = new List<string>();
        foreach (var scope in new[] { EnvironmentVariableTarget.Machine, EnvironmentVariableTarget.User })
        {
            try
            {
                var value = Environment.GetEnvironmentVariable("PATH", scope);
                if (!string.IsNullOrWhiteSpace(value)) parts.Add(value);
            }
            catch
            {
                // An unreadable scope falls back to what this process already has.
            }
        }
        // Appended, never substituted. The registry copy is read to pick up
        // a runtime installed seconds ago, not to decide what the launcher
        // is allowed to find - and handing a child a PATH with this
        // process's own entries removed is the same mistake :REFRESHPATH
        // made in start-aurion.cmd, where it left the machine unable to
        // locate powershell.exe.
        parts.Insert(0, Environment.GetEnvironmentVariable("PATH") ?? "");

        // Both of AURION's own runtimes, so the launcher finds them even
        // when nothing on this machine has ever heard of them.
        parts.Add(Path.Combine(_installDir, "runtime", "node"));
        parts.Add(Path.Combine(_installDir, "runtime", "python"));
        parts.Add(Path.Combine(_installDir, "runtime", "python", "Scripts"));

        return string.Join(';', parts.Where(p => p.Length > 0).Distinct());
    }

    /// <summary>How long each log was when this run started.</summary>
    private readonly Dictionary<string, long> _logMarks = new();

    private string LogPath(string name) => Path.Combine(_installDir, "data", "logs", name);

    /// <summary>
    /// Remember where each log ends, so a failure can quote this run only.
    ///
    /// engine.log and desk.log are appended to, never truncated. Quoting
    /// their last few lines meant quoting a successful start from three
    /// weeks ago and presenting it as the reason today's run failed.
    /// </summary>
    private void MarkLogs()
    {
        foreach (var name in new[] { "engine.log", "desk.log", "setup.log" })
        {
            try
            {
                var path = LogPath(name);
                _logMarks[name] = File.Exists(path) ? new FileInfo(path).Length : 0L;
            }
            catch
            {
                _logMarks[name] = 0L;
            }
        }
    }

    /// <summary>Whatever this run appended to one log, trimmed to fit a dialog.</summary>
    private string NewIn(string name, int maxLines)
    {
        try
        {
            var path = LogPath(name);
            if (!File.Exists(path)) return "";

            var from = _logMarks.TryGetValue(name, out var mark) ? mark : 0L;
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            if (stream.Length <= from) return "";
            stream.Position = from;

            using var reader = new StreamReader(stream);
            var lines = reader.ReadToEnd()
                .Split('\n')
                .Select(l => l.TrimEnd('\r'))
                .Where(l => l.Trim().Length > 0)
                .ToList();
            return lines.Count == 0 ? "" : string.Join(Environment.NewLine, lines.TakeLast(maxLines));
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// Everything known about why the desk is not answering.
    ///
    /// Written for somebody who cannot be asked to open a log: what this run
    /// actually printed, which interpreters were used, and - the single most
    /// common cause that no log will ever mention - what else is holding
    /// port 8080.
    /// </summary>
    private string Diagnosis(int? launcherExitCode)
    {
        var parts = new List<string>();

        var engine = NewIn("engine.log", 6);
        var desk = NewIn("desk.log", 6);
        var setup = NewIn("setup.log", 8);

        if (engine.Length > 0) parts.Add("The engine said:" + Environment.NewLine + engine);
        if (desk.Length > 0) parts.Add("The desk said:" + Environment.NewLine + desk);

        if (engine.Length == 0 && desk.Length == 0)
        {
            parts.Add("Neither the engine nor the desk wrote anything this time, "
                      + "so they did not get as far as starting.");

            // Which makes setup.log the only account of what did happen.
            // Leaving it out was how a failure got reported as four facts
            // and no reason.
            if (setup.Length > 0)
            {
                parts.Add("Setup said:" + Environment.NewLine + setup);
            }
            else
            {
                parts.Add("The launcher wrote nothing either, so it stopped before "
                          + "it could choose an interpreter.");
            }
        }

        var runtimes = Runtimes();
        if (runtimes.Length > 0) parts.Add(runtimes);

        var holder = WhoHasPort8080();
        if (holder.Length > 0) parts.Add(holder);

        if (launcherExitCode is int code && code != 0)
        {
            parts.Add($"The launcher stopped with code {code}.");
        }

        var all = string.Join(Environment.NewLine + Environment.NewLine, parts);
        Note("startup failed. " + all.Replace(Environment.NewLine, " | "));
        return all;
    }

    /// <summary>The interpreters setup recorded, so a wrong one is visible.</summary>
    private string Runtimes()
    {
        try
        {
            var file = Path.Combine(_installDir, "data", "runtime.env");
            if (!File.Exists(file)) return "";
            var lines = File.ReadAllLines(file).Where(l => l.Contains('=')).ToList();
            // Labelled as what it is. This is the file from the last
            // successful setup, not necessarily what this run chose - and
            // reading it as the latter wasted a round trip.
            return lines.Count == 0
                ? ""
                : "Recorded by the last setup (not necessarily what ran now):"
                  + Environment.NewLine + string.Join(Environment.NewLine, lines);
        }
        catch
        {
            return "";
        }
    }

    /// <summary>
    /// Name whatever else is listening on 8080.
    ///
    /// No log can report this, because the process that would have written
    /// the log is the one that could not bind. It is also the most common
    /// cause after a missing prerequisite, and the only one the trader can
    /// act on without help.
    /// </summary>
    private string WhoHasPort8080()
    {
        try
        {
            var mine = System.Net.NetworkInformation.IPGlobalProperties.GetIPGlobalProperties()
                .GetActiveTcpListeners()
                .Any(e => e.Port == 8080);
            if (!mine) return "Nothing is listening on port 8080.";

            // Something has it. If it were ours the health check would have
            // answered, so it is another program.
            return "Port 8080 is held by another program. AURION's desk cannot "
                 + "start while something else has it.";
        }
        catch
        {
            return "";
        }
    }

    private async Task<bool> DeskIsAnsweringAsync()
    {
        try
        {
            using var r = await _http.GetAsync(HealthUrl, HttpCompletionOption.ResponseHeadersRead);
            return r.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private void ShowStartupFailure(string reason = "")
    {
        var logs = Path.Combine(_installDir, "data", "logs");
        _splash.Status = "AURION did not finish starting.";
        _splash.Progress = 0f;

        var said = reason.Trim().Length > 0
            ? "AURION could not start the desk.\n\nFrom this attempt:\n\n" + reason.Trim() + "\n\n"
            : "AURION did not finish starting within three minutes, and nothing "
              + "was written explaining why.\n\n";

        MessageBox.Show(this,
            said +
            "The full logs are here:\n" +
            $"    {Path.Combine(logs, "engine.log")}\n" +
            $"    {Path.Combine(logs, "desk.log")}\n" +
            $"    {Path.Combine(logs, "window.log")}\n\n" +
            "Starting AURION again will check the machine and repair anything missing.",
            "AURION", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }

    // ------------------------------------------------------------- web view

    /// <summary>Tell the desk whether its window is visible right now.</summary>
    private void ReportVisibility()
    {
        var hidden = WindowState == FormWindowState.Minimized || !Visible;
        try
        {
            _view.CoreWebView2?.PostWebMessageAsString(
                "{\"type\":\"visibility\",\"hidden\":" + (hidden ? "true" : "false") + "}");
        }
        catch
        {
            // The view may not be ready yet; the next resize will report again.
        }
    }

    private void RaiseWindow()
    {
        Show();
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Activate();
        BringToFront();
    }

    private void OpenSignalFromToast()
    {
        RaiseWindow();
        if (_pendingSymbol.Length == 0) return;
        try
        {
            var payload = "{\"type\":\"open-signal\",\"symbol\":\"" + Escape(_pendingSymbol) +
                          "\",\"timeframe\":\"" + Escape(_pendingTimeframe) + "\"}";
            _view.CoreWebView2?.PostWebMessageAsString(payload);
        }
        catch
        {
            // Raising the window is the important half; navigation is a bonus.
        }
    }

    private static string Escape(string value) =>
        value.Replace("\\", "\\\\").Replace("\"", "\\\"");

    /// <summary>A signal arrived while the window was not visible.</summary>
    private void ShowSignalToast(string title, string body, string symbol, string timeframe)
    {
        _pendingSymbol = symbol ?? "";
        _pendingTimeframe = timeframe ?? "";
        try
        {
            _tray.Visible = true;
            _tray.BalloonTipTitle = string.IsNullOrWhiteSpace(title) ? "AURION" : title;
            _tray.BalloonTipText = body ?? "";
            _tray.BalloonTipIcon = ToolTipIcon.Info;
            _tray.ShowBalloonTip(8000);
        }
        catch
        {
            // A missing notification area is not a reason to fail a signal.
        }
    }

    private async Task ShowDeskAsync()
    {
        // Kept out of the user's own browser profile: their tabs, sign-ins and
        // extensions are never touched, and this window keeps its own state.
        var profile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "AxiaSoft", "AURION", "Window");
        Directory.CreateDirectory(profile);

        try
        {
            var env = await CoreWebView2Environment.CreateAsync(null, profile);
            if (!Controls.Contains(_view))
            {
                Controls.Add(_view);
                _view.SendToBack();
            }
            await _view.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            OfferBrowserFallback(
                "The Microsoft Edge WebView2 runtime is missing.\n\n" +
                "It is part of Windows 11 and of every up-to-date Windows 10, so this " +
                "is unusual. AURION will open in your browser instead.\n\n" +
                "To get the window back, install the WebView2 runtime from Microsoft.");
            return;
        }
        catch (Exception ex)
        {
            OfferBrowserFallback($"The AURION window could not be created:\n\n{ex.Message}\n\n" +
                                 "AURION will open in your browser instead.");
            return;
        }

        var core = _view.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = true;
        // Left ON deliberately. This is a local desk, not a kiosk: when a page
        // fails to build, F12 is the only way anyone can say WHY, and a blank
        // window with no console is the worst thing to hand a user.
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsSwipeNavigationEnabled = false;

        // The desk is a local application, not a place to browse from: anything
        // pointing somewhere else opens in the user's real browser.
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            OpenExternally(e.Uri);
        };
        core.NavigationStarting += (_, e) =>
        {
            if (!IsDesk(e.Uri))
            {
                e.Cancel = true;
                OpenExternally(e.Uri);
            }
        };
        core.WebMessageReceived += (_, e) =>
        {
            string raw;
            try { raw = e.TryGetWebMessageAsString(); }
            catch { return; }
            if (string.IsNullOrWhiteSpace(raw) || !raw.Contains("\"signal\"")) return;

            // Deliberately a hand-rolled read of four known fields rather than
            // a JSON dependency: the host has exactly one message to parse and
            // its shape is defined a few lines away in app.js.
            ShowSignalToast(Field(raw, "title"), Field(raw, "body"),
                            Field(raw, "symbol"), Field(raw, "timeframe"));
        };

        core.DocumentTitleChanged += (_, _) =>
        {
            // The desk's own <title> is "AURION", so appending the product name
            // produced "AURION — AURION" in the title bar and the taskbar
            // tooltip. Only a page that says something else gets a suffix.
            var t = (core.DocumentTitle ?? "").Trim();
            Text = t.Length == 0 || t.Contains("127.0.0.1") || t.Equals("AURION", StringComparison.OrdinalIgnoreCase)
                ? "AURION"
                : $"{t} — AURION";
        };

        // Hold the splash until the desk has actually painted, so the window
        // never shows an empty white frame between the two.
        core.NavigationCompleted += (_, _) =>
        {
            _splash.Progress = 1f;
            _view.Visible = true;
            _splash.Visible = false;
            ReportVisibility();
        };
        _view.Source = new Uri(DeskUrl);
    }

    private static bool IsDesk(string uri) =>
        Uri.TryCreate(uri, UriKind.Absolute, out var u) &&
        (u.IsLoopback || u.Scheme is "data" or "blob" or "about");

    private static void OpenExternally(string uri)
    {
        try
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
        }
        catch
        {
            // A link we cannot hand over is not worth crashing the desk for.
        }
    }

    private void OfferBrowserFallback(string message)
    {
        MessageBox.Show(this, message, "AURION", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        OpenExternally(DeskUrl);
        Close();
    }

    // ------------------------------------------------------------ placement

    private string PlacementFile => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "AxiaSoft", "AURION", "window.txt");

    private void LoadPlacement()
    {
        try
        {
            if (!File.Exists(PlacementFile)) return;
            var parts = File.ReadAllText(PlacementFile).Split(',');
            if (parts.Length != 5) return;

            var bounds = new Rectangle(
                int.Parse(parts[0]), int.Parse(parts[1]),
                int.Parse(parts[2]), int.Parse(parts[3]));

            // Only restore a position that is still on a connected monitor:
            // an unplugged second screen must not hide the window off-desktop.
            if (!Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(bounds))) return;

            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            if (parts[4] == "max") WindowState = FormWindowState.Maximized;
        }
        catch
        {
            // A corrupt placement file just means "use the default size".
        }
    }

    private void SavePlacement()
    {
        try
        {
            var b = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            var state = WindowState == FormWindowState.Maximized ? "max" : "normal";
            Directory.CreateDirectory(Path.GetDirectoryName(PlacementFile)!);
            File.WriteAllText(PlacementFile, $"{b.X},{b.Y},{b.Width},{b.Height},{state}");
        }
        catch
        {
            // Remembering the size is a nicety, never a reason to block closing.
        }
    }

    /// <summary>
    /// The window icon, which is also what Windows shows on the taskbar button
    /// and in Alt+Tab. Form.Icon does NOT inherit the executable's icon, so
    /// leaving it unset gives the stock WinForms placeholder.
    /// </summary>
    /// <summary>The logo for the splash, taken from the same embedded icon as
    /// the window icon so there is only ever one source of the mark.</summary>
    private static Image? SplashMark()
    {
        try
        {
            var icon = LoadIcon();
            if (icon is null) return null;
            using var sized = new Icon(icon, new Size(128, 128));
            return sized.ToBitmap();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>Pull one string field out of the desk's small JSON message.</summary>
    private static string Field(string json, string name)
    {
        var key = "\"" + name + "\":\"";
        var at = json.IndexOf(key, StringComparison.Ordinal);
        if (at < 0) return "";
        at += key.Length;
        var sb = new System.Text.StringBuilder();
        for (var i = at; i < json.Length; i++)
        {
            var c = json[i];
            if (c == '\\' && i + 1 < json.Length) { sb.Append(json[++i]); continue; }
            if (c == '"') break;
            sb.Append(c);
        }
        return sb.ToString();
    }

    private static Icon? LoadIcon()
    {
        // The .ico carries 256/128/64/48/32/24/16 frames, so Windows can pick
        // the right one for the taskbar, the title bar and the task switcher.
        try
        {
            using var stream = typeof(AppWindow).Assembly.GetManifestResourceStream("AURION.ico");
            if (stream is not null) return new Icon(stream);
        }
        catch
        {
            // fall through to the executable's own icon
        }

        try
        {
            var exe = Environment.ProcessPath;
            if (exe is not null) return Icon.ExtractAssociatedIcon(exe);
        }
        catch
        {
            // Last resort: WinForms default. Never fail to open over an icon.
        }

        return null;
    }
}
