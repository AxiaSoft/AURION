using System.Drawing;
using System.Windows.Forms;

namespace Aurion.Shell;

/// <summary>
/// What a trader sees when they remove AURION.
///
/// Windows' own uninstall experience for an MSI is a progress bar with no
/// name on it, and before that a yes/no box that cannot explain anything.
/// The one decision that actually matters here - whether four years of
/// trade history goes with the application - is not a decision Windows has
/// any way to ask about, and it is not one to get wrong silently.
///
/// So this asks it, in the product's own language, and defaults to keeping
/// the data.
/// </summary>
internal sealed class UninstallWindow : BrandForm
{
    private readonly string _productCode;
    private readonly string _installFolder;

    private readonly Label _title = new();
    private readonly Label _lead = new();
    private readonly Label _status = new();
    private readonly ChoiceCard _keep;
    private readonly ChoiceCard _wipe;
    private readonly BrandButton _remove = new();
    private readonly BrandButton _cancel = new();
    private readonly SweepBar _bar = new();

    private bool _busy;

    public UninstallWindow(string productCode, string installFolder)
        : base("Remove AURION", 620, 480)
    {
        _productCode = productCode;
        _installFolder = installFolder;

        _keep = new ChoiceCard(
            "Keep my trading data",
            "Settings, trade history, exports and licence stay in place. "
            + "Installing AURION again picks up exactly where this left off.");
        _wipe = new ChoiceCard(
            "Remove everything",
            "Deletes the database, logs, exports and licence as well. "
            + "This cannot be undone.");

        Build();
        _keep.Selected = true;
    }

    private void Build()
    {
        var close = new BrandButton
        {
            Text = "✕",
            Size = new Size(36, 28),
            Location = new Point(ClientSize.Width - 48, 12),
            Font = Brand.Body,
        };
        close.Click += (_, _) => { if (!_busy) Close(); };
        Controls.Add(close);

        _title.Text = "Remove AURION?";
        _title.Font = Brand.Title;
        _title.ForeColor = Brand.Ink;
        _title.AutoSize = true;
        _title.BackColor = Color.Transparent;
        _title.Location = new Point(40, 44);
        Controls.Add(_title);
        DragFrom(_title);

        _lead.Text = "AURION will stop running and be removed from this computer.";
        _lead.Font = Brand.Body;
        _lead.ForeColor = Brand.Muted;
        _lead.AutoSize = false;
        _lead.BackColor = Color.Transparent;
        _lead.Location = new Point(42, 90);
        _lead.Size = new Size(ClientSize.Width - 84, 24);
        Controls.Add(_lead);
        DragFrom(_lead);

        _keep.Location = new Point(40, 128);
        _keep.Size = new Size(ClientSize.Width - 80, 84);
        _keep.Click += (_, _) => Choose(keep: true);
        Controls.Add(_keep);

        _wipe.Location = new Point(40, 222);
        _wipe.Size = new Size(ClientSize.Width - 80, 84);
        _wipe.Click += (_, _) => Choose(keep: false);
        Controls.Add(_wipe);

        _bar.Location = new Point(40, 326);
        _bar.Size = new Size(ClientSize.Width - 80, 4);
        _bar.Visible = false;
        Controls.Add(_bar);

        _status.Font = Brand.Small;
        _status.ForeColor = Brand.Muted;
        _status.AutoSize = false;
        _status.BackColor = Color.Transparent;
        _status.Location = new Point(42, 340);
        _status.Size = new Size(ClientSize.Width - 84, 34);
        Controls.Add(_status);

        _cancel.Text = "Keep AURION";
        _cancel.Location = new Point(ClientSize.Width - 330, ClientSize.Height - 72);
        _cancel.Click += (_, _) => { if (!_busy) Close(); };
        Controls.Add(_cancel);

        _remove.Text = "Remove";
        _remove.Primary = true;
        _remove.Destructive = true;
        _remove.Location = new Point(ClientSize.Width - 170, ClientSize.Height - 72);
        _remove.Click += async (_, _) => await RemoveAsync();
        Controls.Add(_remove);

        // Escape is the safe answer here, so it is the one bound.
        KeyDown += (_, e) => { if (e.KeyCode == Keys.Escape && !_busy) Close(); };
    }

    private void Choose(bool keep)
    {
        if (_busy) return;
        _keep.Selected = keep;
        _wipe.Selected = !keep;
        _remove.Destructive = !keep;
        _remove.Text = keep ? "Remove" : "Remove everything";
        _remove.Invalidate();
    }

    private async Task RemoveAsync()
    {
        if (_busy) return;
        _busy = true;

        _keep.Enabled = _wipe.Enabled = false;
        _remove.Enabled = _cancel.Enabled = false;
        _remove.Invalidate();
        _cancel.Invalidate();

        _title.Text = "Removing AURION";
        _lead.Text = "This usually takes under a minute.";
        _bar.Visible = true;
        _bar.Start();

        var log = Path.Combine(Path.GetTempPath(), "AURION-uninstall.log");
        var say = new Progress<string>(text => _status.Text = text);

        // AURION_REMOVE_DATA is read by AurionRemoveUserData in Actions.wxs.
        // The default is to keep everything, so the property is only passed
        // when the user has actually asked for the data to go.
        var extra = _wipe.Selected ? " AURION_REMOVE_DATA=all" : "";

        try
        {
            _status.Text = "Asking Windows Installer to remove AURION…";
            var code = await Msi.RunAsync($"/x {_productCode}{extra}", log, say, CancellationToken.None);

            _bar.Stop();

            if (Msi.Succeeded(code))
            {
                _title.Text = "AURION has been removed";
                _lead.Text = _wipe.Selected
                    ? "The application and all of its data are gone from this computer."
                    : "Your trading data is still on this computer, ready for next time.";
                _status.Text = "";
                _bar.Visible = false;

                _cancel.Text = "Close";
                _cancel.Enabled = true;
                _cancel.Primary = true;
                _cancel.Location = new Point(ClientSize.Width - 170, ClientSize.Height - 72);
                _cancel.Invalidate();
                _remove.Visible = false;
                _busy = false;
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
        _bar.Visible = false;
        _title.Text = "AURION could not be removed";
        _lead.Text = why.Length > 0 ? why : "Windows Installer did not say why.";
        _status.Text = "The full log is at " + log;

        _remove.Enabled = true;
        _remove.Text = "Try again";
        _remove.Invalidate();
        _cancel.Enabled = true;
        _cancel.Text = "Close";
        _cancel.Invalidate();
        _keep.Enabled = _wipe.Enabled = true;
        _busy = false;
    }
}
