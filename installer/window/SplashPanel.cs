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

    // 30 frames a second, not 62.
    //
    // The sweep is a band gliding along a four pixel bar. Nobody has ever
    // been able to tell those two rates apart on that, and the difference
    // is half the painting.
    private readonly System.Windows.Forms.Timer _ticker = new() { Interval = 33 };

    // Built once each, not once per frame.
    //
    // Creating a Font goes through the font engine, and MeasureString is
    // the most expensive text call GDI+ has. This panel did three of each,
    // plus a full-window gradient, two radial glows and several brushes,
    // sixty-two times a second. On a developer's machine that is invisible.
    // On a bare VM with no graphics acceleration it saturates the core the
    // message loop runs on, and Windows greys the window out and writes
    // "not responding" across the title bar - while the thing it is waiting
    // for is working perfectly well on a background thread.
    private readonly Font _titleFont = new("Segoe UI", 22f, FontStyle.Regular, GraphicsUnit.Point);
    private readonly Font _subFont = new("Segoe UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
    private readonly Font _statusFont = new("Segoe UI", 8.5f, FontStyle.Regular, GraphicsUnit.Point);
    private readonly SolidBrush _inkBrush = new(Ink);
    private readonly SolidBrush _mutedBrush = new(Muted);
    private readonly SolidBrush _trackBrush = new(Color.FromArgb(38, 255, 255, 255));

    // Everything that does not move: the wash, the glows, the mark and the
    // two lines of wordmark. Redrawn only when the panel changes size.
    private Bitmap? _backdrop;
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
            // Only the strip holding the bar and the status line. Painting
            // the whole panel to animate four pixels of progress is what
            // made this expensive in the first place.
            Invalidate(AnimatedStrip());
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

    /// <summary>The band of the panel the animation actually touches.</summary>
    private Rectangle AnimatedStrip()
    {
        var centreY = Height / 2;
        return new Rectangle(0, centreY + 38, Width, 64);
    }

    protected override void OnResize(EventArgs e)
    {
        // The backdrop is sized to the panel, so it cannot outlive a resize.
        _backdrop?.Dispose();
        _backdrop = null;
        base.OnResize(e);
        Invalidate();
    }

    protected override void OnVisibleChanged(EventArgs e)
    {
        // No reason to paint a panel nobody is looking at. The desk window
        // keeps this alive behind the WebView for the whole session.
        if (Visible) _ticker.Start(); else _ticker.Stop();
        base.OnVisibleChanged(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _ticker.Dispose();
            _backdrop?.Dispose();
            _titleFont.Dispose();
            _subFont.Dispose();
            _statusFont.Dispose();
            _inkBrush.Dispose();
            _mutedBrush.Dispose();
            _trackBrush.Dispose();
        }
        base.Dispose(disposing);
    }

    /// <summary>
    /// Draw the parts that never change, once, into a bitmap.
    ///
    /// The wash is a gradient the size of the window and the glows are two
    /// radial gradients a third of it across. None of them move. Redrawing
    /// them every frame to animate a progress bar was most of the cost of
    /// this panel.
    /// </summary>
    private Bitmap BuildBackdrop(int w, int h)
    {
        var bmp = new Bitmap(w, h);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;

        // The same backdrop the setup wizard and the uninstaller are
        // painted on. Four lights rather than two, a vignette, and a
        // sparse dither that stops the gradients banding into visible
        // arcs on an 8-bit display.
        Aurion.Shell.Aurora.Paint(g, w, h);

        var centreY = h / 2f;

        // Mark. The .ico carries an opaque brand-black tile, which would read
        // as a hard square floating on the wash, so it is clipped to a rounded
        // rectangle - the same corner treatment the desk gives its own logo.
        if (_mark is not null)
        {
            float size = Math.Min(96, Math.Max(56, h / 6));
            var box = new RectangleF((w - size) / 2f, centreY - size - 58, size, size);

            // A halo, so the mark sits in the light rather than on it.
            Aurion.Shell.Aurora.Halo(g, box.X + size / 2f, box.Y + size / 2f, size * 0.62f);

            using var clip = RoundedRect(box, size * 0.26f);
            var saved = g.Save();
            g.SetClip(clip);
            g.DrawImage(_mark, box);
            g.Restore(saved);
        }

        // Letter-spaced by hand, one glyph at a time.
        //
        // GDI+ has no tracking. A six-letter wordmark set solid at 22pt
        // reads as a word; the same letters opened up read as a mark,
        // which is what this is. It is drawn once into the bitmap, so
        // the per-glyph cost never appears again.
        DrawTracked(g, "AURION", _titleFont, _inkBrush, w, centreY - 38, 7f);

        var subText = "Live execution for MetaTrader 5";
        var subSize = g.MeasureString(subText, _subFont);
        g.DrawString(subText, _subFont, _mutedBrush, (w - subSize.Width) / 2f, centreY + 6);

        return bmp;
    }

    /// <summary>Draw a centred string with extra space between letters.</summary>
    private static void DrawTracked(Graphics g, string text, Font font, Brush brush,
        int width, float y, float tracking)
    {
        var widths = new float[text.Length];
        var total = 0f;
        for (var i = 0; i < text.Length; i++)
        {
            // MeasureString pads; MeasureCharacterRanges is exact, but for
            // a six-letter wordmark the padding is consistent enough and
            // far cheaper to reason about.
            widths[i] = g.MeasureString(text[i].ToString(), font).Width - font.Size * 0.42f;
            total += widths[i] + tracking;
        }
        total -= tracking;

        var x = (width - total) / 2f;
        for (var i = 0; i < text.Length; i++)
        {
            g.DrawString(text[i].ToString(), font, brush, x - font.Size * 0.21f, y);
            x += widths[i] + tracking;
        }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        var w = Width;
        var h = Height;
        if (w <= 0 || h <= 0) return;

        _backdrop ??= BuildBackdrop(w, h);
        g.DrawImageUnscaled(_backdrop, 0, 0);

        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var centreY = h / 2f;

        // Progress track
        var barW = Math.Min(360, w - 96);
        var barX = (w - barW) / 2f;
        var barY = centreY + 46;
        const float barH = 4f;

        FillPill(g, _trackBrush, barX, barY, barW, barH);

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
            var size = g.MeasureString(_status, _statusFont);
            g.DrawString(_status, _statusFont, _mutedBrush, (w - size.Width) / 2f, barY + 18);
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
