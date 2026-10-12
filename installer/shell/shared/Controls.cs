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
        // Selectable, for the same reason BrandButton is: these cards
        // carry the only consequential choices either installer makes -
        // whether the trade history goes, whether there is a desktop
        // shortcut - and without this they could not be reached with Tab
        // or answered with Space.
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                 | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                 | ControlStyles.SupportsTransparentBackColor
                 | ControlStyles.Selectable, true);
        TabStop = true;
        Cursor = Cursors.Hand;
        BackColor = Color.Transparent;
    }

    protected override void OnMouseEnter(EventArgs e) { _hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hot = false; Invalidate(); base.OnMouseLeave(e); }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (Enabled && CanFocus) Focus();
        base.OnMouseDown(e);
    }

    protected override bool IsInputKey(Keys keyData) =>
        keyData == Keys.Space || keyData == Keys.Enter || base.IsInputKey(keyData);

    protected override void OnKeyUp(KeyEventArgs e)
    {
        if (e.KeyCode is Keys.Space or Keys.Enter)
        {
            e.Handled = true;
            if (Enabled) OnClick(EventArgs.Empty);
        }
        base.OnKeyUp(e);
    }

    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

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

        if (Focused && Enabled)
        {
            var ring = new RectangleF(3.5f, 3.5f, Width - 7f, Height - 7f);
            using var focusPath = Brand.Rounded(ring, 8f);
            using var pen = new Pen(Brand.Focus, 1.6f) { DashStyle = DashStyle.Dot };
            g.DrawPath(pen, focusPath);
        }
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

/// <summary>
/// The close glyph.
///
/// It was a BrandButton with a bordered box around a multiplication sign,
/// which is the one control in either window that should not look like a
/// button: it sits in the chrome, not in the content, and a framed box up
/// there competes with the real actions at the bottom.
/// </summary>
internal sealed class CloseGlyph : Control
{
    private bool _hot;

    public CloseGlyph()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                 | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                 | ControlStyles.SupportsTransparentBackColor
                 | ControlStyles.Selectable, true);
        TabStop = true;
        BackColor = Color.Transparent;
        Cursor = Cursors.Hand;
        Size = new Size(34, 28);
    }

    protected override void OnMouseEnter(EventArgs e) { _hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hot = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }

    protected override bool IsInputKey(Keys keyData) =>
        keyData == Keys.Enter || keyData == Keys.Space || base.IsInputKey(keyData);

    protected override void OnKeyUp(KeyEventArgs e)
    {
        if (e.KeyCode is Keys.Enter or Keys.Space) { e.Handled = true; OnClick(EventArgs.Empty); }
        base.OnKeyUp(e);
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (CanFocus) Focus();
        base.OnMouseDown(e);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        if (FindForm() is BrandForm host) host.PaintBackdropUnder(e.Graphics, Bounds);
        else base.OnPaintBackground(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        var r = new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f);
        if (_hot || Focused)
        {
            using var shape = Brand.Rounded(r, 7f);
            using var fill = new SolidBrush(Color.FromArgb(_hot ? 42 : 22, 255, 120, 120));
            g.FillPath(fill, shape);
        }

        var cx = Width / 2f;
        var cy = Height / 2f;
        const float a = 4.5f;
        using var pen = new Pen(_hot ? Brand.Danger : Brand.Muted, 1.6f);
        g.DrawLine(pen, cx - a, cy - a, cx + a, cy + a);
        g.DrawLine(pen, cx + a, cy - a, cx - a, cy + a);
    }
}

/// <summary>A hairline, to separate the actions from what they act on.</summary>
internal sealed class Hairline : Control
{
    public Hairline()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                 | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        Height = 1;
        TabStop = false;
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        if (FindForm() is BrandForm host) host.PaintBackdropUnder(e.Graphics, Bounds);
        else base.OnPaintBackground(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        using var brush = new SolidBrush(Brand.Hairline);
        e.Graphics.FillRectangle(brush, 0, 0, Width, Height);
    }
}

/// <summary>
/// Which page of the wizard this is, as dots rather than "Step 2 of 4".
///
/// Four pages is few enough that a sentence counting them is noise, and
/// the one thing somebody wants from a progress indicator - is this nearly
/// over - is answered faster by looking than by reading.
/// </summary>
internal sealed class StepDots : Control
{
    private int _count = 3;
    private int _at;

    public int Count { get => _count; set { _count = Math.Max(1, value); Invalidate(); } }
    public int At { get => _at; set { _at = value; Invalidate(); } }

    public StepDots()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                 | ControlStyles.OptimizedDoubleBuffer | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        TabStop = false;
        Size = new Size(80, 10);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        if (FindForm() is BrandForm host) host.PaintBackdropUnder(e.Graphics, Bounds);
        else base.OnPaintBackground(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        const float d = 7f;
        const float gap = 9f;
        var wide = _count * d + (_count - 1) * gap;
        var x = (Width - wide) / 2f;
        var y = (Height - d) / 2f;

        for (var i = 0; i < _count; i++)
        {
            var here = i == _at;
            using var brush = new SolidBrush(here
                ? Brand.Cyan
                : Color.FromArgb(i < _at ? 90 : 46, 255, 255, 255));
            g.FillEllipse(brush, x + i * (d + gap), y, d, d);
        }
    }
}
