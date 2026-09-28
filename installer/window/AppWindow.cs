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

    public AppWindow()
    {
        Text = "AURION";
        BackColor = Color.FromArgb(0x06, 0x07, 0x0B);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(DefaultWidth, DefaultHeight);
        MinimumSize = new Size(900, 600);
        WindowState = FormWindowState.Normal;
        Icon = LoadIcon();

        _splash = new SplashPanel(SplashMark()) { Status = "Starting AURION…" };
        Controls.Add(_view);
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
        if (await DeskIsAnsweringAsync())
        {
            _splash.Status = "Connecting to the desk…";
            _splash.Progress = 0.85f;
        }
        else
        {
            _splash.Status = "Starting the engine…";
            if (!StartDesk()) return;

            var clock = Stopwatch.StartNew();
            while (clock.Elapsed < StartupBudget)
            {
                await Task.Delay(500);

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
                ShowStartupFailure();
                return;
            }
        }

        _splash.Status = "Loading the desk…";
        _splash.Progress = 0.92f;
        await ShowDeskAsync();
    }

    /// <summary>Runs the application's own launcher, hidden, and lets it do its job.</summary>
    private bool StartDesk()
    {
        var starter = Path.Combine(_installDir, "start-aurion.cmd");
        if (!File.Exists(starter))
        {
            MessageBox.Show(this,
                $"AURION is not installed correctly:\n\n{starter} is missing.\n\n" +
                "Use Settings > Apps > AURION > Modify > Repair to restore it.",
                "AURION", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return false;
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

        try
        {
            Process.Start(psi);
            return true;
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, $"AURION could not be started:\n\n{ex.Message}",
                "AURION", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
            return false;
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

    private void ShowStartupFailure()
    {
        var logs = Path.Combine(_installDir, "data", "logs");
        _splash.Status = "AURION did not finish starting.";
        _splash.Progress = 0f;
        MessageBox.Show(this,
            "AURION did not finish starting within three minutes.\n\n" +
            "The engine and desk write the real reason here:\n" +
            $"    {Path.Combine(logs, "engine.log")}\n" +
            $"    {Path.Combine(logs, "desk.log")}\n\n" +
            "The usual causes are a missing prerequisite or port 8080 being held " +
            "by another program.",
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
