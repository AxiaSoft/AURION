using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Windows.Forms;

namespace Aurion.Shell;

/// <summary>
/// A choice, drawn as a card rather than as a radio button or a checkbox.
///
/// Both installers ask small numbers of consequential questions - whether
/// the trade history goes, whether there is a desktop shortcut - and a
/// 13-pixel system control with a label beside it is the wrong weight for
/// a question somebody should actually read.
///
/// <see cref="Tick"/> switches between the two meanings: a dot for "one of
/// these", a tick for "yes or no".
/// </summary>
internal sealed class ChoiceCard : Control
{
    private readonly string _heading;
    private readonly string _detail;
    private bool _hot;
    private bool _selected;

    /// <summary>Draw a tick box rather than a radio dot.</summary>
    public bool Tick { get; set; }

    public bool Selected
    {
        get => _selected;
        set { _selected = value; Invalidate(); }
    }

    public ChoiceCard(string heading, string detail)
    {
        _heading = heading;
        _detail = detail;
        // SupportsTransparentBackColor is not decoration. Control.BackColor
        // throws ArgumentException for any colour with an alpha below 255
        // unless this style is set, and Color.Transparent has an alpha of
        // zero - so the line below it was not a preference, it was an
        // exception thrown from a constructor, before Application.Run had
        // started pumping and therefore before anything could catch it.
        //
        // A WinExe that throws there dies without a window, without a
        // message and without an entry anywhere a normal person would
        // look. AURION-Setup.exe did exactly nothing when double-clicked,
        // every time, for this.
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                 | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                 | ControlStyles.SupportsTransparentBackColor, true);
        Cursor = Cursors.Hand;
        BackColor = Color.Transparent;
    }

    protected override void OnMouseEnter(EventArgs e) { _hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hot = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        // The form's gradient, actually drawn. Leaving this empty is what
        // left artefacts around the rounded corners of every card.
        if (FindForm() is BrandForm host) host.PaintBackdropUnder(e.Graphics, Bounds);
        else base.OnPaintBackground(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var r = new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f);
        using var shape = Brand.Rounded(r, 10f);

        using (var fill = new SolidBrush(Color.FromArgb(_selected ? 26 : (_hot ? 18 : 10), 255, 255, 255)))
            g.FillPath(fill, shape);
        using (var edge = new Pen(_selected ? Brand.Cyan : Brand.Hairline, _selected ? 1.6f : 1f))
            g.DrawPath(edge, shape);

        var box = new RectangleF(18, Height / 2f - 8, 16, 16);
        if (Tick)
        {
            using (var shapeEdge = Brand.Rounded(box, 4f))
            using (var ring = new Pen(_selected ? Brand.Cyan : Brand.Muted, 1.6f))
                g.DrawPath(ring, shapeEdge);

            if (_selected)
            {
                using var mark = new Pen(Brand.Cyan, 2f);
                g.DrawLines(mark, new[]
                {
                    new PointF(box.X + 3.5f, box.Y + 8f),
                    new PointF(box.X + 6.5f, box.Y + 11.5f),
                    new PointF(box.X + 12.5f, box.Y + 4.5f),
                });
            }
        }
        else
        {
            using (var ring = new Pen(_selected ? Brand.Cyan : Brand.Muted, 1.6f))
                g.DrawEllipse(ring, box);
            if (_selected)
            {
                using var core = new SolidBrush(Brand.Cyan);
                g.FillEllipse(core, box.X + 4, box.Y + 4, 8, 8);
            }
        }

        var textLeft = 50;
        var textWidth = Width - textLeft - 20;

        TextRenderer.DrawText(g, _heading, Brand.Strong,
            new Rectangle(textLeft, 16, textWidth, 20),
            Enabled ? Brand.Ink : Brand.Muted,
            TextFormatFlags.Left | TextFormatFlags.SingleLine);

        TextRenderer.DrawText(g, _detail, Brand.Small,
            new Rectangle(textLeft, 38, textWidth, 40), Brand.Muted,
            TextFormatFlags.Left | TextFormatFlags.WordBreak);
    }
}

/// <summary>
/// An indeterminate bar that sweeps, matching the desk's splash.
///
/// Not called Progress: System.Progress&lt;T&gt; is used a few lines above
/// this and the two would differ only by arity.
/// </summary>
internal sealed class SweepBar : Control
{
    private readonly System.Windows.Forms.Timer _ticker = new() { Interval = 33 };
    private float _sweep;

    public SweepBar()
    {
        // As above: without SupportsTransparentBackColor the next line is
        // an ArgumentException, not a colour.
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                 | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                 | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        _ticker.Tick += (_, _) => { _sweep = (_sweep + 0.008f) % 1f; Invalidate(); };
    }

    public void Start() => _ticker.Start();
    public void Stop() => _ticker.Stop();

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        if (FindForm() is BrandForm host) host.PaintBackdropUnder(e.Graphics, Bounds);
        else base.OnPaintBackground(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        var w = (float)Width;
        var h = (float)Height;

        using (var track = new SolidBrush(Color.FromArgb(38, 255, 255, 255)))
            g.FillRectangle(track, 0, 0, w, h);

        var band = w * 0.3f;
        var eased = (float)(0.5 - 0.5 * Math.Cos(_sweep * Math.PI * 2));
        var x = -band + (w + band) * eased;
        var left = Math.Max(0, x);
        var right = Math.Min(x + band, w);
        if (right <= left) return;

        using var fill = new LinearGradientBrush(
            new RectangleF(0, 0, w, h), Brand.Cyan, Brand.Violet, 0f);
        g.FillRectangle(fill, left, 0, right - left, h);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _ticker.Dispose();
        base.Dispose(disposing);
    }
}
