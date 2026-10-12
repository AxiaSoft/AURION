using System.Drawing;
using System.Windows.Forms;

namespace Aurion.Shell;

/// <summary>
/// A question, asked in AURION's own window.
///
/// MessageBox was the obvious thing and the wrong one. These programs
/// exist because Windows Installer's dialogs do not look like AURION; a
/// grey system box on top of them gives that back at the moment the user
/// is making the only irreversible decision in the whole flow.
///
/// Deliberately small and deliberately modal: it has one question, two
/// answers, and no way to dismiss it by accident.
/// </summary>
internal sealed class Ask : BrandForm
{
    private readonly BrandLabel _title = new();
    private readonly BrandLabel _detail = new();
    private readonly BrandButton _yes = new();
    private readonly BrandButton _no = new();

    protected override int CaptionHeight => 48;

    private Ask(string title, string detail, string confirm, string cancel, bool destructive)
        : base(title, 460, 232)
    {
        _title.Text = title;
        _title.Font = Brand.Heading;
        _title.Location = new Point(32, 34);
        _title.Size = new Size(ClientSize.Width - 64, 26);
        _title.Fit(2);
        Controls.Add(_title);
        DragFrom(_title);

        _detail.Text = detail;
        _detail.ForeColor = Brand.Muted;
        _detail.Location = new Point(32, 68);
        _detail.Size = new Size(ClientSize.Width - 64, 60);
        _detail.Fit(3);
        Controls.Add(_detail);

        // Laid out from the right edge, and each button sized to its own
        // caption - "Leave setup" and "Stay" are not the same width and
        // were never going to be.
        _yes.Text = confirm;
        _yes.Primary = true;
        _yes.Destructive = destructive;
        _yes.RightAligned = true;
        _yes.MinimumWidth = 110;
        _yes.FitToText();
        _yes.Location = new Point(ClientSize.Width - 32 - _yes.Width, ClientSize.Height - 68);
        _yes.Click += (_, _) => { DialogResult = DialogResult.Yes; Close(); };
        Controls.Add(_yes);

        _no.Text = cancel;
        _no.RightAligned = true;
        _no.MinimumWidth = 100;
        _no.FitToText();
        _no.Location = new Point(_yes.Left - 12 - _no.Width, ClientSize.Height - 68);
        _no.Click += (_, _) => { DialogResult = DialogResult.No; Close(); };
        Controls.Add(_no);

        _no.TabIndex = 0;
        _yes.TabIndex = 1;

        StartPosition = FormStartPosition.CenterParent;
        ShowInTaskbar = false;

        KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Escape) { DialogResult = DialogResult.No; Close(); }
        };
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // The safe answer has focus. Enter should never be the one that
        // throws work away.
        _no.Focus();
    }

    /// <summary>Ask, and return true only for an explicit yes.</summary>
    public static bool Show(IWin32Window owner, string title, string detail,
        string confirm, string cancel, bool destructive = false)
    {
        using var dialog = new Ask(title, detail, confirm, cancel, destructive);
        return dialog.ShowDialog(owner) == DialogResult.Yes;
    }
}
