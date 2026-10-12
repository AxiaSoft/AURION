using System.Drawing;
using System.Windows.Forms;

namespace Aurion.Shell;

/// <summary>
/// The wizard a customer meets before AURION exists on their machine.
///
/// Windows Installer's dialogs can be given a banner bitmap and a licence
/// page, and that is the end of it: the typeface, the spacing, the
/// buttons and the word "Setup" in the title bar stay Microsoft's. For a
/// product whose entire first impression is this window, that is the
/// wrong first impression.
///
/// So the MSI runs with /qn and everything visible is drawn here. The MSI
/// is still what installs: upgrades, repair, rollback and Add or Remove
/// Programs all keep working, because none of that is being replaced.
///
/// Four pages, in the order the decisions actually arrive:
///
///     Welcome -> Where -> Shortcuts -> Installing -> Done
///
/// There used to be an "Options" button on the welcome page instead,
/// which is the shape you choose when you have settings you would rather
/// nobody saw. Where a program puts itself and what it adds to the Start
/// menu are not advanced questions; they are the two things a person
/// installing software actually wants to be asked.
/// </summary>
internal sealed class SetupWindow : BrandForm
{
    private const int Margin = 44;
    private const int Pad = 2;

    private enum Page { Welcome = 0, Where = 1, Shortcuts = 2, Working = 3, Done = 4 }

    private readonly string _msiPath;
    private readonly bool _alreadyInstalled;

    private readonly BrandLabel _title = new();
    private readonly BrandLabel _lead = new();
    private readonly BrandLabel _status = new();
    private readonly SweepBar _bar = new();

    private readonly BrandLabel _whereLabel = new();
    private readonly BrandLabel _wherePath = new();
    private readonly BrandButton _browse = new();
    private readonly BrandLabel _whereNote = new();

    private readonly ChoiceCard _startMenu;
    private readonly ChoiceCard _desktop;

    private readonly StepDots _steps = new();
    private readonly Hairline _rule = new();
    private readonly BrandButton _primary = new();
    private readonly BrandButton _secondary = new();
    private readonly CloseGlyph _close = new();

    private Page _page = Page.Welcome;
    private bool _busy;
    private string _folder = DefaultFolder();

    public SetupWindow(string msiPath, bool alreadyInstalled)
        : base("AURION setup", 660, 540)
    {
        _msiPath = msiPath;
        _alreadyInstalled = alreadyInstalled;

        _startMenu = new ChoiceCard(
            "Add AURION to the Start menu",
            "So it can be found by typing its name, like everything else.")
        { Tick = true, Selected = true };

        _desktop = new ChoiceCard(
            "Put a shortcut on the desktop",
            "Off by default. The Start menu entry is usually enough.")
        { Tick = true, Selected = false };

        Build();
        Show(Page.Welcome);
    }

    protected override void PaintBrand(Graphics g, int w, int h)
    {
        if (Mark is null) return;
        const int size = 72;
        var x = (w - size) / 2f;
        const float y = 48f;
        Aurora.Halo(g, x + size / 2f, y + size / 2f, size * 0.62f);
        g.DrawImage(Mark, new RectangleF(x, y, size, size));
    }

    // ----------------------------------------------------------- layout --

    private void Build()
    {
        var inner = ClientSize.Width - Margin * 2;

        _close.Location = new Point(ClientSize.Width - 46, 14);
        _close.Click += (_, _) => TryClose();
        Controls.Add(_close);

        _title.Font = Brand.Title;
        _title.Location = new Point(Margin, 148);
        _title.Size = new Size(inner, 34);
        Controls.Add(_title);

        _lead.ForeColor = Brand.Muted;
        _lead.Location = new Point(Margin + Pad, 190);
        _lead.Size = new Size(inner - Pad * 2, 64);
        Controls.Add(_lead);

        /* ---- where ------------------------------------------------------ */

        _whereLabel.Text = "Folder";
        _whereLabel.Font = Brand.Small;
        _whereLabel.ForeColor = Brand.Muted;
        _whereLabel.Location = new Point(Margin + Pad, 266);
        _whereLabel.Size = new Size(inner, 18);
        Controls.Add(_whereLabel);

        _browse.Text = "Change…";
        _browse.MinimumWidth = 104;
        _browse.RightAligned = true;
        _browse.Height = 38;
        _browse.FitToText();
        _browse.Location = new Point(ClientSize.Width - Margin - _browse.Width, 288);
        _browse.Click += (_, _) => Browse();
        Controls.Add(_browse);

        _wherePath.Font = Brand.Body;
        _wherePath.Location = new Point(Margin + Pad, 296);
        _wherePath.Size = new Size(inner - _browse.Width - 16, 22);
        Controls.Add(_wherePath);

        _whereNote.Font = Brand.Small;
        _whereNote.ForeColor = Brand.Muted;
        _whereNote.Location = new Point(Margin + Pad, 336);
        _whereNote.Size = new Size(inner - Pad * 2, 54);
        Controls.Add(_whereNote);

        /* ---- shortcuts --------------------------------------------------- */

        _startMenu.Location = new Point(Margin, 266);
        _startMenu.Size = new Size(inner, 78);
        _startMenu.Click += (_, _) => _startMenu.Selected = !_startMenu.Selected;
        Controls.Add(_startMenu);

        _desktop.Location = new Point(Margin, 354);
        _desktop.Size = new Size(inner, 78);
        _desktop.Click += (_, _) => _desktop.Selected = !_desktop.Selected;
        Controls.Add(_desktop);

        /* ---- working ----------------------------------------------------- */

        _bar.Location = new Point(Margin, 300);
        _bar.Size = new Size(inner, 4);
        Controls.Add(_bar);

        _status.Font = Brand.Small;
        _status.ForeColor = Brand.Muted;
        _status.Location = new Point(Margin + Pad, 316);
        _status.Size = new Size(inner - Pad * 2, 54);
        Controls.Add(_status);

        /* ---- footer ------------------------------------------------------ */

        _steps.Count = 3;
        _steps.Size = new Size(140, 10);
        _steps.Location = new Point((ClientSize.Width - 140) / 2, ClientSize.Height - 112);
        Controls.Add(_steps);

        _rule.Location = new Point(Margin, ClientSize.Height - 92);
        _rule.Size = new Size(inner, 1);
        Controls.Add(_rule);

        _primary.Primary = true;
        _primary.RightAligned = true;
        _primary.Click += async (_, _) => await PrimaryAsync();
        Controls.Add(_primary);

        _secondary.RightAligned = true;
        _secondary.Click += (_, _) => Secondary();
        Controls.Add(_secondary);

        KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape) TryClose(); };
    }

    /// <summary>
    /// Put the two actions against the right margin, widest first.
    ///
    /// Fixed positions do not survive captions that change: "Install"
    /// and "Install what is missing" are not the same width, and the
    /// second used to be drawn clipped inside the first one's box.
    /// </summary>
    private void LayOutActions()
    {
        var y = ClientSize.Height - 70;

        _primary.FitToText();
        _primary.Location = new Point(ClientSize.Width - Margin - _primary.Width, y);

        _secondary.FitToText();
        _secondary.Location = new Point(_primary.Left - 12 - _secondary.Width, y);
    }

    // ------------------------------------------------------------ pages --

    private void Show(Page page)
    {
        _page = page;

        var where = page == Page.Where;
        _whereLabel.Visible = _wherePath.Visible = _browse.Visible = _whereNote.Visible = where;

        var shortcuts = page == Page.Shortcuts;
        _startMenu.Visible = _desktop.Visible = shortcuts;

        var working = page == Page.Working;
        _bar.Visible = working;
        _status.Visible = working || page == Page.Done;

        _steps.Visible = page is Page.Welcome or Page.Where or Page.Shortcuts;
        _steps.At = page switch { Page.Welcome => 0, Page.Where => 1, _ => 2 };

        switch (page)
        {
            case Page.Welcome:
                _title.Text = _alreadyInstalled ? "Update AURION" : "Install AURION";
                _lead.Text = _alreadyInstalled
                    ? "This replaces the version already on this computer. Your settings, "
                      + "trade history and licence are left exactly as they are."
                    : "AURION installs for you only, in your own user folder. It needs no "
                      + "administrator, changes nothing for anyone else using this computer, "
                      + "and brings everything it depends on with it.";
                _primary.Text = "Continue";
                _secondary.Text = "Cancel";
                _secondary.Visible = true;
                break;

            case Page.Where:
                _title.Text = "Where it goes";
                _lead.Text = "Anywhere you can write to without an administrator.";
                _wherePath.Text = _folder;
                _whereNote.Text = "AURION needs about 400 MB here, including its own copies of "
                                  + "Python and Node.js. Nothing is installed outside this folder.";
                _primary.Text = _alreadyInstalled ? "Continue" : "Continue";
                _secondary.Text = "Back";
                _secondary.Visible = true;
                break;

            case Page.Shortcuts:
                _title.Text = "How to reach it";
                _lead.Text = "Both can be changed later from Settings.";
                _primary.Text = _alreadyInstalled ? "Update" : "Install";
                _secondary.Text = "Back";
                _secondary.Visible = true;
                break;

            case Page.Working:
                _title.Text = _alreadyInstalled ? "Updating AURION" : "Installing AURION";
                _lead.Text = "A couple of minutes. Nothing needs to be downloaded.";
                _primary.Text = "Installing…";
                _secondary.Visible = false;
                break;

            case Page.Done:
                _title.Text = "AURION is ready";
                _lead.Text = "The first start sets up the trading engine, which takes a minute "
                             + "or two. After that it opens straight away.";
                _status.Text = "Installed in " + _folder;
                _primary.Text = "Start AURION";
                _secondary.Text = "Close";
                _secondary.Visible = true;
                break;
        }

        _primary.Enabled = page != Page.Working;
        _lead.Fit(3);
        _whereNote.Fit(3);
        _status.Fit(3);
        LayOutActions();
        Invalidate();
    }

    // ---------------------------------------------------------- actions --

    private static string DefaultFolder() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs", "AURION");

    private void Browse()
    {
        using var picker = new FolderBrowserDialog
        {
            Description = "Choose where AURION goes",
            UseDescriptionForTitle = true,
            ShowNewFolderButton = true,
            SelectedPath = Directory.Exists(_folder) ? _folder : DefaultFolder(),
        };
        if (picker.ShowDialog(this) != DialogResult.OK) return;

        var chosen = picker.SelectedPath;

        // Choosing "Documents" should not scatter AURION across it. If the
        // folder does not already end in the product name, put it in one.
        if (!string.Equals(new DirectoryInfo(chosen).Name, "AURION", StringComparison.OrdinalIgnoreCase))
        {
            chosen = Path.Combine(chosen, "AURION");
        }

        _folder = chosen;
        _wherePath.Text = _folder;
    }

    private void Secondary()
    {
        if (_busy) return;
        switch (_page)
        {
            case Page.Welcome: TryClose(); break;
            case Page.Where: Show(Page.Welcome); break;
            case Page.Shortcuts: Show(Page.Where); break;
            case Page.Done: Close(); break;
        }
    }

    private async Task PrimaryAsync()
    {
        if (_busy) return;
        switch (_page)
        {
            case Page.Welcome: Show(Page.Where); break;
            case Page.Where: Show(Page.Shortcuts); break;
            case Page.Shortcuts: await InstallAsync(); break;
            case Page.Done: StartAurion(); Close(); break;
        }
    }

    private void TryClose()
    {
        if (_page == Page.Done) { Close(); return; }

        var leaving = _busy
            ? Ask.Show(this, "Stop installing AURION?",
                "It is part-way through. Stopping now can leave an incomplete "
                + "installation that has to be removed before trying again.",
                "Stop anyway", "Keep installing", destructive: true)
            : Ask.Show(this, "Leave setup?",
                "AURION has not been installed yet. Nothing has been changed on "
                + "this computer.",
                "Leave setup", "Stay");

        if (leaving) Close();
    }

    private async Task InstallAsync()
    {
        _busy = true;
        Show(Page.Working);
        _bar.Start();
        _status.Text = "Starting Windows Installer…";

        var log = Path.Combine(Path.GetTempPath(), "AURION-install.log");
        var say = new Progress<string>(text => { _status.Text = text; _status.Fit(3); });

        // Properties the MSI already understands.
        //
        // AURION_SKIP_PROVISION is deliberate: Python and Node are set up
        // by the desk window on its first start, where there is a splash,
        // a progress bar, a clock on the slow steps and an explanation.
        // Letting the MSI do it as well would be two different-looking
        // setups running back to back.
        var properties =
            $" INSTALLFOLDER=\"{_folder}\"" +
            $" AURION_WANT_STARTMENU={(_startMenu.Selected ? 1 : 0)}" +
            $" AURION_WANT_DESKTOP={(_desktop.Selected ? 1 : 0)}" +
            " AURION_SKIP_PROVISION=1";

        try
        {
            var code = await Msi.RunAsync($"/i \"{_msiPath}\"{properties}", log, say,
                CancellationToken.None);
            _bar.Stop();
            _busy = false;

            if (Msi.Succeeded(code)) { Show(Page.Done); return; }
            Failed(Msi.Explain(code), log);
        }
        catch (Exception ex)
        {
            _bar.Stop();
            _busy = false;
            Failed(ex.Message, log);
        }
    }

    private void Failed(string why, string log)
    {
        _bar.Visible = false;
        _title.Text = "AURION could not be installed";
        _lead.Text = why.Length > 0 ? why : "Windows Installer did not say why.";
        _status.Visible = true;
        _status.Text = "The full log is at " + log;

        _page = Page.Shortcuts;      // so "Try again" runs the install again
        _primary.Enabled = true;
        _primary.Text = "Try again";
        _secondary.Visible = true;
        _secondary.Text = "Close";
        _steps.Visible = false;

        _lead.Fit(3);
        _status.Fit(3);
        LayOutActions();
    }

    private void StartAurion()
    {
        try
        {
            var exe = Path.Combine(_folder, "AURION.exe");
            if (!File.Exists(exe)) return;
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = exe,
                WorkingDirectory = _folder,
                UseShellExecute = true,
            });
        }
        catch
        {
            // The install succeeded. Failing to launch is not worth an
            // error box over a shortcut the user already has.
        }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        _primary.Focus();
    }
}
