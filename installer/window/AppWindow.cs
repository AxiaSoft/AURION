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
    private readonly Label _status = new()
    {
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleCenter,
        ForeColor = Color.FromArgb(0xE8, 0xED, 0xF7),
        BackColor = Color.FromArgb(0x06, 0x07, 0x0B),
        Font = new Font("Segoe UI", 11F),
        Text = "Starting AURION…",
    };

    private readonly string _installDir = AppContext.BaseDirectory.TrimEnd('\\');
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

        Controls.Add(_view);
        Controls.Add(_status);

        LoadPlacement();
        Shown += async (_, _) => await BootAsync();
        FormClosing += (_, _) => SavePlacement();
    }

    // ----------------------------------------------------------------- boot

    private async Task BootAsync()
    {
        if (!await DeskIsAnsweringAsync())
        {
            if (!StartDesk()) return;

            var clock = Stopwatch.StartNew();
            while (clock.Elapsed < StartupBudget)
            {
                await Task.Delay(1000);
                _status.Text = $"Starting AURION…  ({clock.Elapsed.Seconds + clock.Elapsed.Minutes * 60}s)";
                if (await DeskIsAnsweringAsync()) break;
            }

            if (!await DeskIsAnsweringAsync())
            {
                ShowStartupFailure();
                return;
            }
        }

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
        _status.Text = "AURION did not finish starting.";
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
        core.Settings.AreDevToolsEnabled = false;
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
        core.DocumentTitleChanged += (_, _) =>
        {
            var t = core.DocumentTitle;
            Text = string.IsNullOrWhiteSpace(t) || t.Contains("127.0.0.1") ? "AURION" : $"{t} — AURION";
        };

        _view.Source = new Uri(DeskUrl);
        _view.Visible = true;
        _status.Visible = false;
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
