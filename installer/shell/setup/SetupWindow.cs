using System.Drawing;
using System.Windows.Forms;

namespace Aurion.Shell;

/// <summary>
/// The wizard a customer meets before AURION exists on their machine.
///
/// Windows Installer's own dialogs cannot be made to look like this. They
/// can be given a banner bitmap and a licence page and that is the end of
/// it - the typeface, the spacing, the buttons and the word "Setup" in the
/// title bar all stay Microsoft's. For a product whose whole first
/// impression is this window, that is the wrong first impression.
///
/// So the MSI is run with /qn, with no interface at all, and everything
/// the user sees is drawn here. The MSI is still the thing that installs:
/// upgrades, repair, rollback and Add or Remove Programs all keep working
/// exactly as they did, because none of that is being replaced.
/// </summary>
internal sealed class SetupWindow : BrandForm
{
    private readonly string _msiPath;
    private readonly bool _alreadyInstalled;

    private readonly BrandLabel _title = new();
    private readonly BrandLabel _lead = new();
    private readonly BrandLabel _status = new();
    private readonly SweepBar _bar = new();

    private readonly ChoiceCard _startMenu;
    private readonly ChoiceCard _desktop;
    private readonly BrandLabel _whereLabel = new();

    private readonly BrandButton _primary = new();
    private readonly BrandButton _secondary = new();
    private readonly CloseGlyph _close = new();
    private readonly StepDots _steps = new();
    private readonly Hairline _rule = new();

    private int _page;
    private bool _busy;
    private string _installFolder = "";

    public SetupWindow(string msiPath, bool alreadyInstalled)
        : base("AURION setup", 660, 520)
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
        ShowPage(0);
    }

    private void Build()
    {
        _close.Location = new Point(ClientSize.Width - 48, 14);
        _close.Click += (_, _) => TryClose();
        Controls.Add(_close);

        _steps.Count = 3;
        _steps.Size = new Size(120, 10);
        _steps.Location = new Point((ClientSize.Width - 120) / 2, ClientSize.Height - 104);
        Controls.Add(_steps);

        _rule.Location = new Point(40, ClientSize.Height - 90);
        _rule.Size = new Size(ClientSize.Width - 80, 1);
        Controls.Add(_rule);

        _title.Font = Brand.Title;
        _title.ForeColor = Brand.Ink;
        _title.Location = new Point(44, 150);
        _title.Size = new Size(ClientSize.Width - 88, 36);
        Controls.Add(_title);
        DragFrom(_title);

        _lead.Font = Brand.Body;
        _lead.ForeColor = Brand.Muted;
        _lead.Location = new Point(46, 192);
        _lead.Size = new Size(ClientSize.Width - 92, 60);
        Controls.Add(_lead);
        DragFrom(_lead);

        _startMenu.Location = new Point(44, 262);
        _startMenu.Size = new Size(ClientSize.Width - 88, 76);
        _startMenu.Click += (_, _) => Toggle(_startMenu);
        Controls.Add(_startMenu);

        _desktop.Location = new Point(44, 348);
        _desktop.Size = new Size(ClientSize.Width - 88, 76);
        _desktop.Click += (_, _) => Toggle(_desktop);
        Controls.Add(_desktop);

        _whereLabel.Font = Brand.Small;
        _whereLabel.ForeColor = Brand.Muted;
        _whereLabel.Location = new Point(46, 434);
        _whereLabel.Size = new Size(ClientSize.Width - 92, 20);
        Controls.Add(_whereLabel);

        _bar.Location = new Point(44, 300);
        _bar.Size = new Size(ClientSize.Width - 88, 4);
        _bar.Visible = false;
        Controls.Add(_bar);

        _status.Font = Brand.Small;
        _status.ForeColor = Brand.Muted;
        _status.Location = new Point(46, 314);
        _status.Size = new Size(ClientSize.Width - 92, 36);
        Controls.Add(_status);

        _secondary.Location = new Point(ClientSize.Width - 340, ClientSize.Height - 74);
        _secondary.Click += (_, _) => Secondary();
        Controls.Add(_secondary);

        _primary.Primary = true;
        _primary.Location = new Point(ClientSize.Width - 180, ClientSize.Height - 74);
        _primary.Click += async (_, _) => await PrimaryAsync();
        Controls.Add(_primary);

        KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape) TryClose(); };

        // Tab goes through the window the way it reads.
        var order = new Control[] { _startMenu, _desktop, _secondary, _primary, _close };
        for (var i = 0; i < order.Length; i++) order[i].TabIndex = i;
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // So Enter does the obvious thing the moment the window appears,
        // without anyone having to find the button with Tab first.
        _primary.Focus();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);

        // The mark, above the heading. Drawn rather than placed in a
        // PictureBox so it sits on the gradient without a grey rectangle
        // behind it.
        if (Mark is null) return;
        const int size = 72;
        var x = (ClientSize.Width - size) / 2;
        e.Graphics.DrawImage(Mark, new Rectangle(x, 56, size, size));
    }

    private static void Toggle(ChoiceCard card) => card.Selected = !card.Selected;

    private void TryClose()
    {
        if (_busy)
        {
            // Killing an installation halfway is how a machine ends up
            // with a half-written AURION and an Add or Remove Programs
            // entry that cannot be removed.
            var answer = MessageBox.Show(this,
                "AURION is being installed.\n\nStopping now can leave the installation "
                + "incomplete. Wait for it to finish?",
                "AURION", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (answer == DialogResult.Yes) return;
        }
        Close();
    }

    private void ShowPage(int page)
    {
        _page = page;

        var options = page == 1;
        _startMenu.Visible = _desktop.Visible = _whereLabel.Visible = options;

        var working = page == 2;
        _bar.Visible = working;
        _status.Visible = working || page == 3;

        switch (page)
        {
            case 0:
                _title.Text = _alreadyInstalled ? "Update AURION" : "Install AURION";
                _lead.Text = _alreadyInstalled
                    ? "This will replace the version already on this computer. Your settings, "
                      + "trade history and licence are left exactly as they are."
                    : "AURION installs for you only, in your own user folder. It needs no "
                      + "administrator, changes nothing for other people using this computer, "
                      + "and brings everything it depends on with it.";
                _primary.Text = _alreadyInstalled ? "Update" : "Install";
                _primary.Enabled = true;
                _secondary.Text = "Options";
                _secondary.Visible = true;
                _secondary.Enabled = true;
                break;

            case 1:
                _title.Text = "Options";
                _lead.Text = "Both can be changed later from Settings.";
                _whereLabel.Text = "Installing into  " + DefaultFolder();
                _primary.Text = _alreadyInstalled ? "Update" : "Install";
                _primary.Enabled = true;
                _secondary.Text = "Back";
                _secondary.Visible = true;
                _secondary.Enabled = true;
                break;

            case 2:
                _title.Text = _alreadyInstalled ? "Updating AURION" : "Installing AURION";
                _lead.Text = "This takes a couple of minutes. Nothing needs to be downloaded.";
                _primary.Enabled = false;
                _secondary.Visible = false;
                break;

            case 3:
                _title.Text = "AURION is ready";
                _lead.Text = "The first start sets up the trading engine, which takes a "
                             + "minute or two. After that it opens straight away.";
                _primary.Text = "Start AURION";
                _primary.Enabled = true;
                _secondary.Text = "Close";
                _secondary.Visible = true;
                _secondary.Enabled = true;
                break;
        }

        _steps.At = page >= 2 ? 2 : page;
        _steps.Visible = page != 3;

        _primary.Invalidate();
        _secondary.Invalidate();
        Invalidate();
    }

    private void Secondary()
    {
        if (_busy) return;
        switch (_page)
        {
            case 0: ShowPage(1); break;
            case 1: ShowPage(0); break;
            case 3: Close(); break;
        }
    }

    private async Task PrimaryAsync()
    {
        if (_busy) return;

        if (_page == 3)
        {
            StartAurion();
            Close();
            return;
        }

        await InstallAsync();
    }

    private static string DefaultFolder() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs", "AURION");

    private async Task InstallAsync()
    {
        _busy = true;
        ShowPage(2);
        _bar.Start();
        _status.Text = "Starting Windows Installer…";

        var log = Path.Combine(Path.GetTempPath(), "AURION-install.log");
        var say = new Progress<string>(text => _status.Text = text);

        // The properties the MSI already understands. AURION_SKIP_PROVISION
        // is deliberate: the runtimes are set up by the desk window on its
        // first start, where there is a splash screen, a progress bar and
        // an explanation. Letting the MSI do it as well would mean two
        // different-looking setups running back to back.
        var properties =
            $" AURION_WANT_STARTMENU={(_startMenu.Selected ? 1 : 0)}" +
            $" AURION_WANT_DESKTOP={(_desktop.Selected ? 1 : 0)}" +
            " AURION_SKIP_PROVISION=1";

        try
        {
            var code = await Msi.RunAsync($"/i \"{_msiPath}\"{properties}", log, say,
                CancellationToken.None);
            _bar.Stop();

            if (Msi.Succeeded(code))
            {
                _installFolder = DefaultFolder();
                _status.Text = "";
                _busy = false;
                ShowPage(3);
                return;
            }

            Failed(Msi.Explain(code), log);
        }
        catch (Exception ex)
        {
            _bar.Stop();
            Failed(ex.Message, log);
        }
    }

    private void Failed(string why, string log)
    {
        _busy = false;
        _bar.Visible = false;
        _title.Text = "AURION could not be installed";
        _lead.Text = why.Length > 0 ? why : "Windows Installer did not say why.";
        _status.Visible = true;
        _status.Text = "The full log is at " + log;

        _primary.Text = "Try again";
        _primary.Enabled = true;
        _secondary.Text = "Close";
        _secondary.Visible = true;
        _secondary.Enabled = true;
        _page = 0;
        _primary.Invalidate();
        _secondary.Invalidate();
    }

    private void StartAurion()
    {
        try
        {
            var exe = Path.Combine(_installFolder, "AURION.exe");
            if (!File.Exists(exe)) return;
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = exe,
                WorkingDirectory = _installFolder,
                UseShellExecute = true,
            });
        }
        catch
        {
            // The install succeeded. Failing to launch is not worth an
            // error box over a shortcut the user already has.
        }
    }
}
