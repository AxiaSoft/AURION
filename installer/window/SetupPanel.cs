using System.Drawing;
using System.Drawing.Drawing2D;

namespace Aurion.Window;

/// <summary>
/// The screen a bare machine sees instead of a progress bar that goes nowhere.
///
/// It lists what AURION needs, what this machine already has, and what will be
/// downloaded if the trader says so - naming the vendor and the size of each
/// one before anything is fetched. It is the same dark surface as the splash,
/// so arriving here does not feel like falling out of the product.
///
/// Built from ordinary controls rather than owner-drawn like SplashPanel: this
/// one has to be read, scrolled and clicked, and a hand-painted list would be
/// a reimplementation of everything a Panel already does.
/// </summary>
internal sealed class SetupPanel : Panel
{
    private static readonly Color Base = Color.FromArgb(0x06, 0x07, 0x0B);
    private static readonly Color Card = Color.FromArgb(0x0E, 0x11, 0x1A);
    private static readonly Color Ink = Color.FromArgb(0xE8, 0xED, 0xF7);
    private static readonly Color Muted = Color.FromArgb(0x8B, 0x93, 0xA7);
    private static readonly Color Faint = Color.FromArgb(0x62, 0x68, 0x7A);
    private static readonly Color Cyan = Color.FromArgb(0x3E, 0xE0, 0xC4);
    private static readonly Color Rose = Color.FromArgb(0xFF, 0x6B, 0x8A);
    private static readonly Color Line = Color.FromArgb(0x1E, 0x23, 0x30);

    private readonly List<Requirement> _items;
    private readonly FlowLayoutPanel _list = new()
    {
        Dock = DockStyle.Fill,
        FlowDirection = FlowDirection.TopDown,
        WrapContents = false,
        AutoScroll = true,
        BackColor = Base,
        Padding = new Padding(0, 4, 0, 4),
    };

    private readonly Label _title = new()
    {
        AutoSize = true,
        ForeColor = Ink,
        Font = new Font("Segoe UI", 16f, FontStyle.Regular),
        Text = "AURION needs a few things first",
    };

    private readonly Label _lead = new()
    {
        AutoSize = false,
        Height = 44,
        Dock = DockStyle.Top,
        ForeColor = Muted,
        Font = new Font("Segoe UI", 9.5f),
        Text = "This machine is missing some of what the desk runs on. "
             + "AURION can fetch them from their own vendors and install them for you.",
    };

    private readonly Label _status = new()
    {
        AutoSize = false,
        Dock = DockStyle.Fill,
        TextAlign = ContentAlignment.MiddleLeft,
        ForeColor = Muted,
        Font = new Font("Segoe UI", 9f),
        Text = "",
    };

    private readonly Button _install = new()
    {
        Text = "Install what is missing",
        AutoSize = true,
        FlatStyle = FlatStyle.Flat,
        BackColor = Cyan,
        ForeColor = Color.FromArgb(0x06, 0x10, 0x14),
        Font = new Font("Segoe UI", 9.5f, FontStyle.Bold),
        Padding = new Padding(14, 7, 14, 7),
        Cursor = Cursors.Hand,
    };

    private readonly Button _skip = new()
    {
        Text = "Continue anyway",
        AutoSize = true,
        FlatStyle = FlatStyle.Flat,
        BackColor = Base,
        ForeColor = Muted,
        Font = new Font("Segoe UI", 9.5f),
        Padding = new Padding(12, 7, 12, 7),
        Cursor = Cursors.Hand,
    };

    /// <summary>Raised when the trader asks for the missing pieces to be installed.</summary>
    public event EventHandler? InstallRequested;

    /// <summary>Raised when the trader would rather go on without them.</summary>
    public event EventHandler? SkipRequested;

    public SetupPanel(List<Requirement> items)
    {
        _items = items;
        Dock = DockStyle.Fill;
        BackColor = Base;
        Padding = new Padding(34, 28, 34, 22);
        DoubleBuffered = true;

        _install.FlatAppearance.BorderSize = 0;
        _skip.FlatAppearance.BorderColor = Line;
        _install.Click += (_, _) => InstallRequested?.Invoke(this, EventArgs.Empty);
        _skip.Click += (_, _) => SkipRequested?.Invoke(this, EventArgs.Empty);

        var buttons = new FlowLayoutPanel
        {
            Dock = DockStyle.Right,
            FlowDirection = FlowDirection.LeftToRight,
            AutoSize = true,
            BackColor = Base,
            WrapContents = false,
        };
        buttons.Controls.Add(_install);
        buttons.Controls.Add(_skip);

        var footer = new Panel { Dock = DockStyle.Bottom, Height = 48, BackColor = Base };
        footer.Controls.Add(_status);
        footer.Controls.Add(buttons);

        var header = new Panel { Dock = DockStyle.Top, Height = 84, BackColor = Base };
        _title.Location = new Point(0, 0);
        _lead.Location = new Point(0, 34);
        header.Controls.Add(_lead);
        header.Controls.Add(_title);

        Controls.Add(_list);
        Controls.Add(footer);
        Controls.Add(header);

        Render();
    }

    /// <summary>Redraw every row from the requirements' current state.</summary>
    public void Render()
    {
        if (InvokeRequired) { BeginInvoke(new Action(Render)); return; }

        _list.SuspendLayout();
        _list.Controls.Clear();
        foreach (var req in _items) _list.Controls.Add(Row(req));
        _list.ResumeLayout();

        var missing = _items.Count(r => r.State == ReqState.Missing);
        var failed = _items.Count(r => r.State == ReqState.Failed);
        _install.Visible = missing > 0;
        _install.Text = failed > 0 ? "Try again" : "Install what is missing";

        if (missing == 0 && failed == 0)
        {
            _title.Text = "Everything is ready";
            _lead.Text = "Starting the desk…";
            _skip.Visible = false;
        }
    }

    /// <summary>A line of running commentary under the list.</summary>
    public void Say(string text)
    {
        if (InvokeRequired) { BeginInvoke(new Action(() => Say(text))); return; }
        _status.Text = text;
    }

    /// <summary>Lock the buttons while work is in flight.</summary>
    public void Working(bool busy)
    {
        if (InvokeRequired) { BeginInvoke(new Action(() => Working(busy))); return; }
        _install.Enabled = !busy;
        _skip.Enabled = !busy;
        _install.BackColor = busy ? Line : Cyan;
        _install.ForeColor = busy ? Muted : Color.FromArgb(0x06, 0x10, 0x14);
    }

    private Control Row(Requirement req)
    {
        var card = new Panel
        {
            Width = Math.Max(520, _list.ClientSize.Width - 26),
            Height = 66,
            BackColor = Card,
            Margin = new Padding(0, 0, 0, 8),
            Padding = new Padding(14, 10, 14, 10),
        };
        card.Paint += (_, e) =>
        {
            using var pen = new Pen(Line);
            e.Graphics.DrawRectangle(pen, 0, 0, card.Width - 1, card.Height - 1);
            using var brush = new SolidBrush(Accent(req.State));
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.FillRectangle(brush, 0, 0, 2, card.Height);
        };

        var title = new Label
        {
            AutoSize = true,
            Location = new Point(14, 10),
            ForeColor = Ink,
            Font = new Font("Segoe UI", 10f, FontStyle.Regular),
            Text = req.Title,
        };

        var detail = new Label
        {
            AutoSize = false,
            Location = new Point(14, 32),
            Size = new Size(card.Width - 150, 26),
            ForeColor = Muted,
            Font = new Font("Segoe UI", 8.5f),
            Text = Detail(req),
        };

        var badge = new Label
        {
            AutoSize = true,
            ForeColor = Accent(req.State),
            Font = new Font("Segoe UI", 9f, FontStyle.Bold),
            Text = Word(req.State),
        };
        badge.Location = new Point(card.Width - 130, 12);

        card.Controls.Add(title);
        card.Controls.Add(detail);
        card.Controls.Add(badge);
        return card;
    }

    private static string Detail(Requirement req) => req.State switch
    {
        ReqState.Present => req.Found.Length > 0 ? "Found: " + req.Found : "Already installed.",
        ReqState.Installed => "Installed just now.",
        ReqState.Failed => req.Problem,
        ReqState.Installing => "Working…",
        ReqState.Missing => req.Why + (req.Source.Length > 0
            ? $"   ·   {req.Size} from {req.Source}"
            : ""),
        _ => req.Why,
    };

    private static string Word(ReqState state) => state switch
    {
        ReqState.Present => "ready",
        ReqState.Installed => "installed",
        ReqState.Missing => "missing",
        ReqState.Installing => "installing",
        ReqState.Failed => "failed",
        _ => "checking",
    };

    private static Color Accent(ReqState state) => state switch
    {
        ReqState.Present or ReqState.Installed => Cyan,
        ReqState.Failed => Rose,
        ReqState.Missing => Color.FromArgb(0xE8, 0xC0, 0x7A),
        _ => Faint,
    };
}
