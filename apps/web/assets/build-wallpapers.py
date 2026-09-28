#!/usr/bin/env python3
"""
Generate the AURION wallpapers for the Deep, Aurora and Mesh backgrounds, in a
dark and a light variant each.

They are built rather than drawn by hand so they stay in step with the brand
tokens in apps/web/css/app.css, and so a future palette change is one edit here
instead of six files in an image editor.

    python3 apps/web/assets/build-wallpapers.py

Output: apps/web/assets/bg-{deep,aurora,mesh}-{dark,light}.jpg
JPEG at quality 88 - these are full-bleed photographic gradients where JPEG is
a third of the size of PNG with no visible difference, and the desk loads one
of them on every start.
"""
from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
SIZE = (1920, 1200)

# Brand tokens, mirrored from css/app.css :root
CYAN = (62, 224, 196)
VIOLET = (124, 108, 255)
GOLD = (232, 192, 122)
ROSE = (255, 107, 138)

DARK_BASE = (6, 7, 11)
DARK_LIFT = (16, 18, 28)
LIGHT_BASE = (238, 241, 246)
LIGHT_LIFT = (255, 255, 255)


def lerp(a: tuple, b: tuple, t: float) -> tuple:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def vertical(size, top, bottom) -> Image.Image:
    """A vertical wash, drawn at 1px wide and stretched - much faster than
    touching every pixel, and the result is identical."""
    w, h = size
    strip = Image.new("RGB", (1, h))
    px = strip.load()
    for y in range(h):
        px[0, y] = lerp(top, bottom, y / max(1, h - 1))
    return strip.resize(size, Image.BILINEAR)


def _radial(radius: int, strength: float, falloff: float = 1.9) -> Image.Image:
    """A soft round light, built small and scaled up: drawing 128 circles at
    256px and resizing is both faster and smoother than drawing them full size."""
    n = 256
    m = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(m)
    half = n // 2
    for i in range(half, 0, -1):
        v = int(255 * strength * (1 - i / half) ** falloff)
        if v <= 0:
            continue
        d.ellipse((half - i, half - i, half + i, half + i), fill=v)
    m = m.filter(ImageFilter.GaussianBlur(n * 0.06))
    return m.resize((radius * 2, radius * 2), Image.BICUBIC)


def glow(img: Image.Image, centre, radius: int, colour, strength: float,
         light: bool = False) -> None:
    """Add light to the image.

    On a dark base this has to *add* (screen), not replace: pasting a tinted
    patch through a mask just punches a dull hole, which is what made the first
    attempt look muddy. On a light base the same light is composited normally,
    at lower strength, so it reads as a pastel wash instead of a spotlight.
    """
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    m = _radial(radius, strength)
    mask.paste(m, (int(centre[0]) - radius, int(centre[1]) - radius), m)

    tint = Image.new("RGB", (w, h), colour)
    lit = Image.new("RGB", (w, h), (0, 0, 0))
    lit.paste(tint, (0, 0), mask)

    if light:
        img.paste(Image.composite(tint, img, mask), (0, 0), mask)
    else:
        img.paste(ImageChops.screen(img, lit), (0, 0))


def grain(img: Image.Image, amount: int = 6) -> Image.Image:
    """A little film grain. Large smooth gradients band badly on 6-bit laptop
    panels, and a few levels of noise hide it completely."""
    w, h = img.size
    rnd = random.Random(20260928)
    small = Image.new("L", (w // 3, h // 3))
    small.putdata([128 + rnd.randint(-amount, amount) for _ in range(small.width * small.height)])
    noise = small.resize((w, h), Image.BILINEAR)
    return Image.blend(img, ImageChops.overlay(img, Image.merge("RGB", (noise, noise, noise))), 0.35)


# ---------------------------------------------------------------------------
# Deep - almost nothing. A single soft pool of light low on the page.
# ---------------------------------------------------------------------------
def build_deep(light: bool) -> Image.Image:
    """Almost nothing: a horizon. One wide, very soft band of light low on the
    page and a whisper of colour at the top, so the eye has somewhere to rest
    without the page ever competing with the data on top of it."""
    w, h = SIZE
    if light:
        img = vertical(SIZE, LIGHT_LIFT, lerp(LIGHT_BASE, (218, 225, 236), 0.85))
        glow(img, (w * 0.5, h * 1.02), int(w * 0.85), lerp(CYAN, (255, 255, 255), 0.62), 0.45, True)
        glow(img, (w * 0.5, h * -0.16), int(w * 0.6), lerp(VIOLET, (255, 255, 255), 0.7), 0.3, True)
    else:
        img = vertical(SIZE, lerp(DARK_BASE, (14, 16, 26), 0.85), DARK_BASE)
        glow(img, (w * 0.5, h * 1.02), int(w * 0.88), lerp(CYAN, DARK_BASE, 0.32), 0.52, False)
        glow(img, (w * 0.5, h * -0.14), int(w * 0.62), lerp(VIOLET, DARK_BASE, 0.42), 0.34, False)
    return grain(img)


# ---------------------------------------------------------------------------
# Aurora - wide ribbons of light, the way the name promises.
# ---------------------------------------------------------------------------
def build_aurora(light: bool) -> Image.Image:
    """Curtains of light. Bands alone looked like a blurred flag, so this adds
    the two things that make an aurora read as one: vertical striations inside
    each curtain, and a faint star field above them on the dark variant."""
    w, h = SIZE
    base = (vertical(SIZE, LIGHT_LIFT, lerp(LIGHT_BASE, (212, 221, 235), 0.8)) if light
            else vertical(SIZE, lerp(DARK_BASE, (12, 14, 24), 0.9), DARK_BASE))

    if not light:
        # Stars first, so the curtains wash over them.
        rnd = random.Random(7411)
        d = ImageDraw.Draw(base)
        for _ in range(420):
            x, y = rnd.uniform(0, w), rnd.uniform(0, h * 0.62)
            r = rnd.choice((0.6, 0.8, 1.0, 1.4))
            v = rnd.randint(90, 210)
            d.ellipse((x - r, y - r, x + r, y + r), fill=(v, v, int(v * 1.05)))
        base = base.filter(ImageFilter.GaussianBlur(0.6))

    curtains = Image.new("RGB", SIZE, (0, 0, 0))
    mask = Image.new("L", SIZE, 0)
    cd, md = ImageDraw.Draw(curtains), ImageDraw.Draw(mask)

    bands = [
        (lerp(VIOLET, CYAN, 0.15), 0.30, 300, 0.85, 200),
        (CYAN, 0.46, 250, 1.20, 235),
        (lerp(CYAN, VIOLET, 0.65), 0.60, 190, 1.55, 180),
        (GOLD, 0.78, 130, 0.95, 120),
    ]
    for colour, y0, thickness, freq, alpha in bands:
        top, bottom = [], []
        for x in range(0, w + 16, 16):
            t = x / w
            wave = math.sin(t * math.pi * freq * 2 + y0 * 11) * h * 0.085
            wave += math.sin(t * math.pi * freq * 6 + y0 * 4) * h * 0.028
            y = h * y0 + wave
            # Curtains hang: thin at the top edge, spreading downward.
            top.append((x, y - thickness * 0.30))
            bottom.append((x, y + thickness * 0.70))
        poly = top + list(reversed(bottom))
        cd.polygon(poly, fill=colour)
        md.polygon(poly, fill=alpha if not light else int(alpha * 0.62))

    # Vertical striations: the detail that separates an aurora from a gradient.
    rnd = random.Random(902)
    for _ in range(140):
        x = rnd.uniform(0, w)
        y1 = rnd.uniform(h * 0.18, h * 0.72)
        length = rnd.uniform(h * 0.06, h * 0.22)
        width = rnd.uniform(6, 22)
        md.rectangle((x, y1, x + width, y1 + length), fill=rnd.randint(30, 90))

    mask = mask.filter(ImageFilter.GaussianBlur(70))
    curtains = curtains.filter(ImageFilter.GaussianBlur(55))
    img = Image.composite(curtains, base, mask)
    img = Image.blend(base, img, 0.80 if not light else 0.55)

    glow(img, (w * 0.22, h * 0.34), int(w * 0.34),
         lerp(CYAN, (255, 255, 255) if light else DARK_BASE, 0.25), 0.34, light)
    glow(img, (w * 0.8, h * 0.28), int(w * 0.30),
         lerp(VIOLET, (255, 255, 255) if light else DARK_BASE, 0.25), 0.30, light)
    return grain(img)


# ---------------------------------------------------------------------------
# Mesh - the modern gradient-mesh look: four colour wells, heavily blurred.
# ---------------------------------------------------------------------------
def build_mesh(light: bool) -> Image.Image:
    w, h = SIZE
    base = (vertical(SIZE, LIGHT_LIFT, lerp(LIGHT_BASE, (226, 231, 240), 0.8)) if light
            else vertical(SIZE, lerp(DARK_BASE, DARK_LIFT, 0.65), DARK_BASE))

    # The wells sit inside the frame on purpose: a radial light concentrates
    # almost everything at its centre, so a well parked off-canvas contributes
    # only its faint tail and the whole mesh reads as flat.
    wells = [
        ((0.18, 0.14), VIOLET, 0.95),
        ((0.84, 0.20), CYAN, 0.85),
        ((0.62, 0.88), lerp(VIOLET, ROSE, 0.45), 0.8),
        ((0.12, 0.78), GOLD, 0.45),
        ((0.46, 0.50), lerp(CYAN, VIOLET, 0.5), 0.5),
    ]
    for (cx, cy), colour, strength in wells:
        tint = lerp(colour, (255, 255, 255), 0.55) if light else lerp(colour, DARK_BASE, 0.18)
        glow(base, (w * cx, h * cy), int(w * 0.62), tint, strength * (0.75 if light else 0.95), light)

    base = base.filter(ImageFilter.GaussianBlur(40))
    return grain(base)


THUMB = (320, 200)


def save_thumb(img: Image.Image, name: str) -> None:
    """A small crop for the picker. Cropped from the centre rather than squashed,
    so the preview shows what the wallpaper actually looks like."""
    w, h = img.size
    target = THUMB[0] / THUMB[1]
    if w / h > target:
        new_w = int(h * target)
        img = img.crop(((w - new_w) // 2, 0, (w + new_w) // 2, h))
    else:
        new_h = int(w / target)
        img = img.crop((0, (h - new_h) // 2, w, (h + new_h) // 2))
    thumb = img.resize(THUMB, Image.LANCZOS)
    out = HERE / f"bg-thumb-{name}.jpg"
    thumb.save(out, format="JPEG", quality=82, optimize=True)
    print(f"  {out.name:24} {out.stat().st_size / 1024:6.0f} KB")


def main() -> int:
    builders = {"deep": build_deep, "aurora": build_aurora, "mesh": build_mesh}
    for name, fn in builders.items():
        for light in (False, True):
            img = fn(light)
            out = HERE / f"bg-{name}-{'light' if light else 'dark'}.jpg"
            img.save(out, format="JPEG", quality=88, optimize=True, progressive=True)
            print(f"  {out.name:24} {out.stat().st_size / 1024:6.0f} KB")
            if not light:
                save_thumb(img, name)

    # The default wallpaper is the app's own orb, so its thumbnail comes from
    # the same file the desk actually shows.
    orb = HERE / "login-orb.png"
    if orb.exists():
        save_thumb(Image.open(orb).convert("RGB"), "default")

    print(f"\nWallpapers written to {HERE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
