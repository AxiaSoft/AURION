using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Aurion.Shell;

/// <summary>
/// The look both of AURION's own installers wear.
///
/// There are two of them - the setup wizard and the uninstaller - and they
/// are separate programs that a user meets months apart. Sharing one file
/// is what stops them drifting into looking like two different products,
/// and it is the same palette the desk's splash screen uses, so installing
/// AURION and starting AURION are visibly the same thing.
///
/// Everything is drawn rather than themed. Windows Installer's own dialogs
/// cannot be made to look like this, which is the entire reason these two
/// programs exist.
/// </summary>
internal static class Brand
{
    public static readonly Color Base = Color.FromArgb(0x06, 0x07, 0x0B);
    public static readonly Color Lift = Color.FromArgb(0x12, 0x15, 0x20);
    public static readonly Color Card = Color.FromArgb(0x0E, 0x11, 0x1A);
    public static readonly Color Ink = Color.FromArgb(0xE8, 0xED, 0xF7);
    public static readonly Color Muted = Color.FromArgb(0x8B, 0x93, 0xA7);
    public static readonly Color Cyan = Color.FromArgb(0x3E, 0xE0, 0xC4);
    public static readonly Color Violet = Color.FromArgb(0x7C, 0x6C, 0xFF);
    public static readonly Color Danger = Color.FromArgb(0xFF, 0x6B, 0x6B);
    public static readonly Color Hairline = Color.FromArgb(0x22, 0x27, 0x36);
    public static readonly Color Focus = Color.FromArgb(0x6E, 0xE7, 0xD0);

    // Created once per process. A Font is expensive to build and these are
    // used on every paint; the splash screen was marked "not responding"
    // for building three of them sixty-two times a second.
    public static readonly Font Title = new("Segoe UI", 20f, FontStyle.Regular, GraphicsUnit.Point);
    public static readonly Font Heading = new("Segoe UI", 12f, FontStyle.Regular, GraphicsUnit.Point);
    public static readonly Font Body = new("Segoe UI", 9.5f, FontStyle.Regular, GraphicsUnit.Point);
    public static readonly Font Small = new("Segoe UI", 8.5f, FontStyle.Regular, GraphicsUnit.Point);
    public static readonly Font Strong = new("Segoe UI", 9.5f, FontStyle.Bold, GraphicsUnit.Point);

    /// <summary>The product icon, loaded from the exe's own resources.</summary>
    public static Image? Mark()
    {
        try
        {
            var stream = typeof(Brand).Assembly.GetManifestResourceStream("AURION.ico");
            if (stream is null) return null;
            using var icon = new Icon(stream, 128, 128);
            return icon.ToBitmap();
        }
        catch
        {
            // A missing mark is a cosmetic problem, never a reason to fail
            // an installation.
            return null;
        }
    }

    public static GraphicsPath Rounded(RectangleF r, float radius)
    {
        var d = Math.Max(1f, radius * 2);
        var path = new GraphicsPath();
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    /// <summary>The brand wash, drawn once into a bitmap by the caller.</summary>
    public static void PaintBackdrop(Graphics g, int w, int h)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        using (var wash = new LinearGradientBrush(new Rectangle(0, 0, w, h), Lift, Base, 90f))
            g.FillRectangle(wash, 0, 0, w, h);

        Glow(g, new PointF(w * 0.18f, h * 0.12f), w * 0.46f, Violet, 0.16f);
        Glow(g, new PointF(w * 0.86f, h * 0.34f), w * 0.36f, Cyan, 0.12f);
    }

    private static void Glow(Graphics g, PointF centre, float radius, Color colour, float strength)
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

/// <summary>
/// A flat button that matches the desk.
///
/// WinForms' own Button cannot be made to look like this at any setting:
/// FlatStyle.Flat still draws a system border on focus and still uses the
/// system highlight colour on hover.
/// </summary>
internal sealed class BrandButton : Control
{
    private bool _hot;
    private bool _down;

    public bool Primary { get; set; }
    public bool Destructive { get; set; }

    public BrandButton()
    {
        // Selectable is the whole difference between a button and a
        // picture of one.
        //
        // This derives from Control, which is not selectable by default,
        // and nothing turned it on. The result was an installer whose
        // buttons could not be reached with Tab, could not be pressed
        // with Enter or Space, and showed nothing at all when focused.
        // Every page was mouse-only - including the one that asks whether
        // to delete four years of trade history.
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint
                 | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                 | ControlStyles.Selectable, true);
        TabStop = true;
        Size = new Size(150, 40);
        Cursor = Cursors.Hand;
        Font = Brand.Strong;
        ForeColor = Brand.Ink;
    }

    protected override bool IsInputKey(Keys keyData) =>
        keyData == Keys.Enter || keyData == Keys.Space || base.IsInputKey(keyData);

    protected override void OnKeyDown(KeyEventArgs e)
    {
        if (e.KeyCode is Keys.Enter or Keys.Space) { e.Handled = true; _down = true; Invalidate(); }
        base.OnKeyDown(e);
    }

    protected override void OnKeyUp(KeyEventArgs e)
    {
        if (e.KeyCode is Keys.Enter or Keys.Space)
        {
            e.Handled = true;
            _down = false;
            Invalidate();
            if (Enabled) OnClick(EventArgs.Empty);
        }
        base.OnKeyUp(e);
    }

    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

    protected override void OnTextChanged(EventArgs e)
    {
        // "Install" becomes "Try again"; "Remove" becomes "Remove
        // everything". Same problem as BrandLabel, same fix.
        Parent?.Invalidate(Bounds, false);
        base.OnTextChanged(e);
    }

    protected override void OnMouseEnter(EventArgs e) { _hot = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hot = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e)
    {
        // Clicking something is also how it gets focus everywhere else in
        // Windows.
        if (Enabled && CanFocus) Focus();
        _down = true;
        Invalidate();
        base.OnMouseDown(e);
    }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        // Draw the window's own backdrop under this button, so the rounded
        // corners sit on the gradient instead of on whatever was left in
        // the buffer. Doing nothing here is what made the buttons glitch.
        if (FindForm() is BrandForm host) host.PaintBackdropUnder(e.Graphics, Bounds);
        else base.OnPaintBackground(e);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;

        var r = new RectangleF(0.5f, 0.5f, Width - 1f, Height - 1f);
        using var shape = Brand.Rounded(r, 8f);

        if (!Enabled)
        {
            using var off = new SolidBrush(Color.FromArgb(28, 255, 255, 255));
            g.FillPath(off, shape);
        }
        else if (Primary)
        {
            var a = Destructive ? Brand.Danger : Brand.Cyan;
            var b = Destructive ? Color.FromArgb(0xD9, 0x48, 0x48) : Brand.Violet;
            using var fill = new LinearGradientBrush(r, a, b, 0f);
            g.FillPath(fill, shape);
            if (_hot)
            {
                using var lift = new SolidBrush(Color.FromArgb(_down ? 10 : 26, 255, 255, 255));
                g.FillPath(lift, shape);
            }
        }
        else
        {
            using var fill = new SolidBrush(Color.FromArgb(_hot ? 30 : 16, 255, 255, 255));
            g.FillPath(fill, shape);
            using var edge = new Pen(Brand.Hairline);
            g.DrawPath(edge, shape);
        }

        var ink = Enabled
            ? (Primary ? Color.FromArgb(0x08, 0x0A, 0x12) : Brand.Ink)
            : Brand.Muted;
        TextRenderer.DrawText(g, Text, Font, ClientRectangle, ink,
            TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);

        // Keyboard focus has to be visible or being able to reach a button
        // is worth nothing: the user would be moving an invisible cursor
        // around a window and pressing Enter to find out where it was.
        if (Focused && Enabled)
        {
            var ring = new RectangleF(2.5f, 2.5f, Width - 5f, Height - 5f);
            using var path = Brand.Rounded(ring, 7f);
            using var pen = new Pen(Brand.Focus, 1.8f) { DashStyle = DashStyle.Dot };
            g.DrawPath(pen, path);
        }
    }
}

/// <summary>
/// A Label that sits on the window's gradient rather than on a dark box.
///
/// Label supports a transparent BackColor, but WinForms implements that
/// by filling with the parent's BackColor - a single flat colour. On a
/// window whose background is a gradient with two soft lights in it, that
/// is a visible rectangle, and every line of text had one behind it.
/// </summary>
internal sealed class BrandLabel : Label
{
    public BrandLabel()
    {
        AutoSize = false;
        BackColor = Color.Transparent;
        ForeColor = Brand.Ink;
        Font = Brand.Body;
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        if (FindForm() is BrandForm host) host.PaintBackdropUnder(e.Graphics, Bounds);
        else base.OnPaintBackground(e);
    }

    protected override void OnTextChanged(EventArgs e)
    {
        // Repaint the backdrop under the old text before drawing the new.
        //
        // Both windows rewrite these labels as they move between pages,
        // and a shorter line does not erase a longer one: the control
        // only repaints itself, over a background it believes is already
        // correct. The leftovers of the previous sentence stay on screen.
        Parent?.Invalidate(Bounds, false);
        base.OnTextChanged(e);
    }
}

/// <summary>
/// The window both programs live in: borderless, dark, draggable, with one
/// close button and no system chrome.
/// </summary>
internal class BrandForm : Form
{
    private const int WmNcHitTest = 0x84;
    private const int WmNcLButtonDown = 0xA1;
    private const int HtClient = 0x1;
    private const int HtCaption = 0x2;
    private const int CsDropShadow = 0x20000;

    /// <summary>Height of the band at the top that drags the window.</summary>
    protected virtual int CaptionHeight => 56;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    protected override CreateParams CreateParams
    {
        get
        {
            // A borderless window gets no shadow, and without one it reads
            // as a flat rectangle pasted onto the desktop rather than a
            // window sitting above it.
            var cp = base.CreateParams;
            cp.ClassStyle |= CsDropShadow;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);

        // Rounded corners, where the operating system has them.
        // DWMWA_WINDOW_CORNER_PREFERENCE = 33, DWMWCP_ROUND = 2. Windows 11
        // honours it; Windows 10 returns an error code that is ignored,
        // and the square corners it keeps are the ones it uses everywhere
        // else, so nothing looks out of place either way.
        try
        {
            var round = 2;
            DwmSetWindowAttribute(Handle, 33, ref round, sizeof(int));
        }
        catch
        {
            // Older than dwmapi. The window still works.
        }
    }

    protected override void WndProc(ref Message m)
    {
        base.WndProc(ref m);

        // Drag from anywhere in the header band.
        //
        // Dragging used to work only on the two labels that had been
        // wired up for it, which is not something anyone can see: the
        // window looked draggable everywhere and moved from two places.
        if (m.Msg == WmNcHitTest && (int)m.Result == HtClient)
        {
            var screen = new Point(m.LParam.ToInt32() & 0xFFFF, (m.LParam.ToInt32() >> 16) & 0xFFFF);
            var local = PointToClient(screen);
            if (local.Y >= 0 && local.Y < CaptionHeight) m.Result = (IntPtr)HtCaption;
        }
    }

    private Bitmap? _backdrop;
    private readonly Image? _mark;

    protected Image? Mark => _mark;

    public BrandForm(string title, int width, int height)
    {
        _mark = Brand.Mark();

        // AutoScaleMode.Dpi, because every position below is in raw pixels
        // and every font in points. Without it the layout is built for a
        // 96 DPI display on a machine that is running at 150%, and the
        // result reads as a window that never finished loading.
        AutoScaleMode = AutoScaleMode.Dpi;

        Text = title;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(width, height);
        BackColor = Brand.Base;
        ForeColor = Brand.Ink;
        ShowInTaskbar = true;
        KeyPreview = true;
        DoubleBuffered = true;

        try
        {
            var stream = typeof(Brand).Assembly.GetManifestResourceStream("AURION.ico");
            if (stream is not null) Icon = new Icon(stream);
        }
        catch
        {
            // The stock icon is survivable.
        }
    }

    protected override void OnResize(EventArgs e)
    {
        _backdrop?.Dispose();
        _backdrop = null;
        base.OnResize(e);
        Invalidate();
    }

    private Bitmap? Backdrop()
    {
        var w = ClientSize.Width;
        var h = ClientSize.Height;
        if (w <= 0 || h <= 0) return null;

        if (_backdrop is null || _backdrop.Width != w || _backdrop.Height != h)
        {
            _backdrop?.Dispose();
            _backdrop = new Bitmap(w, h);
            using var g = Graphics.FromImage(_backdrop);
            Brand.PaintBackdrop(g, w, h);
        }
        return _backdrop;
    }

    /// <summary>
    /// Paint the piece of the window's backdrop that sits under a child.
    ///
    /// This is what makes the owner-drawn controls work, and leaving it
    /// out is what made the buttons glitch. They suppressed their own
    /// background so the gradient would show through, but nothing was
    /// drawing the gradient there - so whatever happened to be in the
    /// buffer stayed, and the rounded corners framed it.
    ///
    /// WinForms' own transparency does not solve this either. A control
    /// with a transparent BackColor is filled with the *parent's
    /// BackColor*, which here is one flat dark colour - so labels came
    /// out as dark rectangles sitting on top of the glow rather than in
    /// it. The only thing that matches is the real bitmap, sliced to the
    /// child's bounds.
    /// </summary>
    internal void PaintBackdropUnder(Graphics g, Rectangle bounds)
    {
        var backdrop = Backdrop();
        if (backdrop is null) return;

        var source = Rectangle.Intersect(bounds, new Rectangle(Point.Empty, backdrop.Size));
        if (source.Width <= 0 || source.Height <= 0) return;

        g.DrawImage(backdrop,
            new Rectangle(source.X - bounds.X, source.Y - bounds.Y, source.Width, source.Height),
            source, GraphicsUnit.Pixel);
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        var backdrop = Backdrop();
        if (backdrop is null) return;

        e.Graphics.DrawImageUnscaled(backdrop, 0, 0);

        using var edge = new Pen(Brand.Hairline);
        e.Graphics.DrawRectangle(edge, 0, 0, ClientSize.Width - 1, ClientSize.Height - 1);
    }

    /// <summary>
    /// Kept for controls that sit below the header band and should still
    /// move the window - a caption-height hit test cannot reach those.
    /// </summary>
    protected void DragFrom(Control c)
    {
        c.MouseDown += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;

            // Only inside the header band, so the hit test above and this
            // agree about what counts as the caption.
            var local = PointToClient(c.PointToScreen(e.Location));
            if (local.Y >= CaptionHeight) return;

            ReleaseCapture();
            SendMessage(Handle, WmNcLButtonDown, HtCaption, 0);
        };
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, int wParam, int lParam);

    protected override void Dispose(bool disposing)
    {
        if (disposing) _backdrop?.Dispose();
        base.Dispose(disposing);
    }
}
