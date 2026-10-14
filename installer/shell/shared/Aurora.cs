using System.Drawing;
using System.Drawing.Drawing2D;

namespace Aurion.Shell;

/// <summary>
/// The backdrop every AURION window is painted on.
///
/// One file, used by the desk's loading screen, the setup wizard and the
/// uninstaller. Those are three separate programs a customer meets weeks
/// or months apart, and the only thing that makes them read as one
/// product is that they are literally drawn by the same code.
///
/// It is built once into a bitmap by each caller and then blitted, so
/// none of the work here happens per frame. That matters: the previous
/// backdrop was a gradient and two radial glows redrawn sixty-two times
/// a second, which was enough to make Windows grey the window out and
/// write "not responding" across it on a machine without a GPU.
/// </summary>
internal static class Aurora
{
    public static readonly Color Deep = Color.FromArgb(0x05, 0x06, 0x0A);
    public static readonly Color Rise = Color.FromArgb(0x0D, 0x10, 0x1A);
    public static readonly Color Cyan = Color.FromArgb(0x3E, 0xE0, 0xC4);
    public static readonly Color Violet = Color.FromArgb(0x7C, 0x6C, 0xFF);
    public static readonly Color Indigo = Color.FromArgb(0x3B, 0x5B, 0xFF);
    public static readonly Color Ember = Color.FromArgb(0xFF, 0x8A, 0x5B);

    /// <summary>
    /// Paint the whole backdrop into <paramref name="g"/>.
    /// </summary>
    public static void Paint(Graphics g, int w, int h)
    {
        if (w <= 0 || h <= 0) return;

        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;

        // 1. The ground. A vertical lift rather than a flat fill, so the
        //    top of the window reads as nearer the light.
        using (var ground = new LinearGradientBrush(
                   new Rectangle(0, 0, w, h), Rise, Deep, LinearGradientMode.Vertical))
        {
            g.FillRectangle(ground, 0, 0, w, h);
        }

        // 2. Four lights instead of two.
        //
        //    Two glows read as two glows. Four, at different sizes and
        //    strengths and allowed to overlap, stop being countable and
        //    start being weather - which is the whole idea behind the
        //    name. The warm one is deliberately almost invisible; it is
        //    there to stop the palette going entirely cold.
        Glow(g, w * 0.14f, h * 0.06f, w * 0.62f, Violet, 0.20f);
        Glow(g, w * 0.92f, h * 0.22f, w * 0.52f, Cyan, 0.15f);
        Glow(g, w * 0.58f, h * 1.02f, w * 0.70f, Indigo, 0.16f);
        Glow(g, w * 0.08f, h * 0.88f, w * 0.34f, Ember, 0.05f);

        // 3. A vignette, to put the content back in the middle.
        Vignette(g, w, h);

        // 4. Grain.
        //
        //    Not texture for its own sake. Wide, dark gradients band badly
        //    on 8-bit-per-channel displays, and the banding is clearly
        //    visible across a 660px window - concentric arcs stepping
        //    through the glows. A sparse dither breaks the steps up and
        //    the banding stops being visible. It is drawn once, into the
        //    same cached bitmap as everything else.
        Grain(g, w, h);
    }

    private static void Glow(Graphics g, float cx, float cy, float radius, Color colour, float strength)
    {
        if (radius <= 0) return;

        var rect = new RectangleF(cx - radius, cy - radius, radius * 2, radius * 2);
        using var path = new GraphicsPath();
        path.AddEllipse(rect);

        using var brush = new PathGradientBrush(path)
        {
            CenterColor = Color.FromArgb((int)(255 * strength), colour),
            SurroundColors = new[] { Color.FromArgb(0, colour) },
            CenterPoint = new PointF(cx, cy),
        };

        // A gentler falloff than the default linear one: the light should
        // fade like light, not like a cone.
        brush.SetSigmaBellShape(0.55f, 1f);
        g.FillEllipse(brush, rect);
    }

    private static void Vignette(Graphics g, int w, int h)
    {
        var radius = Math.Max(w, h) * 0.78f;
        var rect = new RectangleF(w / 2f - radius, h / 2f - radius, radius * 2, radius * 2);

        using var path = new GraphicsPath();
        path.AddEllipse(rect);
        using var brush = new PathGradientBrush(path)
        {
            CenterColor = Color.FromArgb(0, 0, 0, 0),
            SurroundColors = new[] { Color.FromArgb(150, 0, 0, 0) },
            CenterPoint = new PointF(w / 2f, h / 2f),
        };
        brush.SetSigmaBellShape(0.9f, 1f);
        g.FillEllipse(brush, rect);
    }

    private static void Grain(Graphics g, int w, int h)
    {
        // Deterministic, so the same window always looks the same and two
        // windows side by side do not shimmer against each other.
        var random = new Random(0x4155_5249);

        using var light = new SolidBrush(Color.FromArgb(7, 255, 255, 255));
        using var dark = new SolidBrush(Color.FromArgb(9, 0, 0, 0));

        var count = w * h / 220;
        for (var i = 0; i < count; i++)
        {
            var x = random.Next(w);
            var y = random.Next(h);
            g.FillRectangle(random.Next(2) == 0 ? light : dark, x, y, 1, 1);
        }
    }

    /// <summary>
    /// The halo behind the product mark.
    ///
    /// Three rings at falling opacity and a soft core. Drawn into the
    /// backdrop rather than animated: a breathing halo costs a full
    /// repaint of the window every frame, and this is the screen that
    /// appears while the machine is at its busiest.
    /// </summary>
    public static void Halo(Graphics g, float cx, float cy, float radius)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;

        using (var core = new GraphicsPath())
        {
            var r = radius * 1.45f;
            core.AddEllipse(cx - r, cy - r, r * 2, r * 2);
            using var brush = new PathGradientBrush(core)
            {
                CenterColor = Color.FromArgb(38, Cyan),
                SurroundColors = new[] { Color.FromArgb(0, Cyan) },
                CenterPoint = new PointF(cx, cy),
            };
            brush.SetSigmaBellShape(0.4f, 1f);
            g.FillEllipse(brush, cx - r, cy - r, r * 2, r * 2);
        }

        for (var i = 0; i < 3; i++)
        {
            var r = radius * (1.04f + i * 0.17f);
            var alpha = 26 - i * 8;
            if (alpha <= 0) break;
            using var pen = new Pen(Color.FromArgb(alpha, 255, 255, 255), 1f);
            g.DrawEllipse(pen, cx - r, cy - r, r * 2, r * 2);
        }
    }

    /// <summary>
    /// The progress bar both the loading screen and the installers use.
    /// </summary>
    /// <param name="progress">0..1 for a known amount, negative for unknown.</param>
    /// <param name="sweep">0..1, the position of the indeterminate band.</param>
    public static void Bar(Graphics g, RectangleF r, float progress, float sweep)
    {
        if (r.Width <= 0 || r.Height <= 0) return;
        g.SmoothingMode = SmoothingMode.AntiAlias;

        using (var track = new SolidBrush(Color.FromArgb(30, 255, 255, 255)))
        using (var trackShape = Pill(r))
        {
            g.FillPath(track, trackShape);
        }

        using var fill = new LinearGradientBrush(r, Cyan, Violet, LinearGradientMode.Horizontal);

        if (progress >= 0f)
        {
            var width = Math.Max(r.Height, r.Width * Math.Clamp(progress, 0f, 1f));
            using var doneShape = Pill(new RectangleF(r.X, r.Y, width, r.Height));
            g.FillPath(fill, doneShape);
            return;
        }

        // Indeterminate: a band that eases at both ends, so it reads as
        // working rather than as stuck at some percentage.
        var band = r.Width * 0.3f;
        var travel = r.Width + band;
        var eased = (float)(0.5 - 0.5 * Math.Cos(sweep * Math.PI * 2));
        var x = r.X - band + travel * eased;
        var left = Math.Max(r.X, x);
        var right = Math.Min(x + band, r.Right);
        if (right <= left) return;

        using var piece = Pill(new RectangleF(left, r.Y, right - left, r.Height));
        g.FillPath(fill, piece);
    }

    private static GraphicsPath Pill(RectangleF r)
    {
        var path = new GraphicsPath();
        var d = r.Height;
        if (r.Width <= d)
        {
            path.AddEllipse(r);
            return path;
        }
        path.AddArc(r.X, r.Y, d, d, 90, 180);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 180);
        path.CloseFigure();
        return path;
    }
}
