using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;

namespace Aurion.Window;

/// <summary>
/// The screen the trader sees while the desk starts.
///
/// It is drawn rather than assembled from controls: a single owner-drawn panel
/// costs nothing, has no flicker once double-buffered, and can render the brand
/// exactly - a plain <see cref="Label"/> saying "Starting AURION…" on a grey
/// form was the placeholder this replaces.
///
/// Progress is honest. Until the engine answers there is no way to know how far
/// along it is, so the bar runs as a sweeping indeterminate band; the moment a
/// real milestone is reached the caller sets <see cref="Progress"/> and the bar
/// switches to a determinate fill. A fake percentage that crawls to 99 and
/// stops is worse than saying nothing.
/// </summary>
internal sealed class SplashPanel : Panel
{
    private static readonly Color Ink = Color.FromArgb(0xE8, 0xED, 0xF7);
    private static readonly Color Muted = Color.FromArgb(0x8B, 0x93, 0xA7);
    private static readonly Color Base = Color.FromArgb(0x06, 0x07, 0x0B);
    private static readonly Color Lift = Color.FromArgb(0x12, 0x15, 0x20);
    private static readonly Color Cyan = Color.FromArgb(0x3E, 0xE0, 0xC4);
    private static readonly Color Violet = Color.FromArgb(0x7C, 0x6C, 0xFF);

    private readonly System.Windows.Forms.Timer _ticker = new() { Interval = 16 };
    private readonly Image? _mark;
    private float _sweep;          // 0..1, position of the indeterminate band
    private float _shown;          // eased value actually painted
    private float _target = -1f;   // < 0 while progress is unknown

    private string _status = "";

    public SplashPanel(Image? mark)
    {
        _mark = mark;
        DoubleBuffered = true;
        Dock = DockStyle.Fill;
        BackColor = Base;
        _ticker.Tick += (_, _) =>
        {
            _sweep = (_sweep + 0.006f) % 1f;
            if (_target >= 0f)
            {
                // Ease towards the target so a jump from 0.2 to 0.9 glides.
                _shown += (_target - _shown) * 0.12f;
            }
            Invalidate();
        };
        _ticker.Start();
    }

    /// <summary>What the desk is doing right now. Empty hides the line.</summary>
    public string Status
    {
        get => _status;
        set { _status = value ?? ""; Invalidate(); }
    }

    /// <summary>0..1 for a known step, or a negative value for "still unknown".</summary>
    public float Progress
    {
        get => _target;
        set { _target = value; if (value >= 0f && _shown <= 0f) _shown = 0.02f; Invalidate(); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _ticker.Dispose();
        base.Dispose(disposing);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;

        var w = Width;
        var h = Height;
        if (w <= 0 || h <= 0) return;

        // Backdrop: the brand wash, then two soft lights, matching the desk's
        // own sign-in screen closely enough that the handover is unnoticeable.
        using (var wash = new LinearGradientBrush(new Rectangle(0, 0, w, h), Lift, Base, 90f))
            g.FillRectangle(wash, 0, 0, w, h);
        DrawGlow(g, new PointF(w * 0.22f, h * 0.18f), w * 0.42f, Violet, 0.16f);
        DrawGlow(g, new PointF(w * 0.82f, h * 0.30f), w * 0.34f, Cyan, 0.12f);

        var centreY = h / 2f;

        // Mark. The .ico carries an opaque brand-black tile, which would read as
        // a hard square floating on the wash, so it is clipped to a rounded
        // rectangle - the same corner treatment the desk gives its own logo.
        if (_mark is not null)
        {
            float size = Math.Min(96, Math.Max(56, h / 6));
            var box = new RectangleF((w - size) / 2f, centreY - size - 52, size, size);
            using var clip = RoundedRect(box, size * 0.26f);
            var saved = g.Save();
            g.SetClip(clip);
            g.DrawImage(_mark, box);
            g.Restore(saved);
        }

        // Wordmark
        using (var title = new Font("Segoe UI", 22f, FontStyle.Regular, GraphicsUnit.Point))
        using (var ink = new SolidBrush(Ink))
        {
            var text = "AURION";
            var size = g.MeasureString(text, title);
            g.DrawString(text, title, ink, (w - size.Width) / 2f, centreY - 34);
        }

        using (var sub = new Font("Segoe UI", 9f, FontStyle.Regular, GraphicsUnit.Point))
        using (var muted = new SolidBrush(Muted))
        {
            var text = "Live execution for MetaTrader 5";
            var size = g.MeasureString(text, sub);
            g.DrawString(text, sub, muted, (w - size.Width) / 2f, centreY + 4);
        }

        // Progress track
        var barW = Math.Min(360, w - 96);
        var barX = (w - barW) / 2f;
        var barY = centreY + 46;
        const float barH = 4f;

        using (var track = new SolidBrush(Color.FromArgb(38, 255, 255, 255)))
            FillPill(g, track, barX, barY, barW, barH);

        using (var fill = new LinearGradientBrush(
                   new RectangleF(barX, barY, barW, barH), Cyan, Violet, 0f))
        {
            if (_target >= 0f)
            {
                var width = Math.Max(barH, barW * Math.Clamp(_shown, 0f, 1f));
                FillPill(g, fill, barX, barY, width, barH);
            }
            else
            {
                // Indeterminate: a band that sweeps and eases at both ends, so
                // it reads as "working" rather than "stuck at some percentage".
                var band = barW * 0.32f;
                var travel = barW + band;
                var eased = (float)(0.5 - 0.5 * Math.Cos(_sweep * Math.PI * 2));
                var x = barX - band + travel * eased;
                var clippedX = Math.Max(barX, x);
                var clippedW = Math.Min(x + band, barX + barW) - clippedX;
                if (clippedW > 0) FillPill(g, fill, clippedX, barY, clippedW, barH);
            }
        }

        // Status line
        if (_status.Length > 0)
        {
            using var font = new Font("Segoe UI", 8.5f, FontStyle.Regular, GraphicsUnit.Point);
            using var brush = new SolidBrush(Muted);
            var size = g.MeasureString(_status, font);
            g.DrawString(_status, font, brush, (w - size.Width) / 2f, barY + 18);
        }
    }

    private static GraphicsPath RoundedRect(RectangleF r, float radius)
    {
        var d = radius * 2;
        var path = new GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    private static void FillPill(Graphics g, Brush brush, float x, float y, float w, float h)
    {
        if (w <= 0) return;
        var r = h / 2f;
        if (w <= h)
        {
            g.FillEllipse(brush, x, y, w, h);
            return;
        }
        using var path = new GraphicsPath();
        path.AddArc(x, y, h, h, 90, 180);
        path.AddArc(x + w - h, y, h, h, 270, 180);
        path.CloseFigure();
        g.FillPath(brush, path);
    }

    private static void DrawGlow(Graphics g, PointF centre, float radius, Color colour, float strength)
    {
        if (radius <= 0) return;
        var rect = new RectangleF(centre.X - radius, centre.Y - radius, radius * 2, radius * 2);
        using var path = new GraphicsPath();
        path.AddEllipse(rect);
        using var brush = new PathGradientBrush(path)
        {
            CenterColor = Color.FromArgb((int)(255 * strength), colour),
            SurroundColors = new[] { Color.FromArgb(0, colour) },
            CenterPoint = centre,
        };
        g.FillEllipse(brush, rect);
    }
}
