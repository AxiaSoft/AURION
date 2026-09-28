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
    w, h = SIZE
    if light:
        img = vertical(SIZE, LIGHT_LIFT, lerp(LIGHT_BASE, (222, 228, 238), 0.6))
        glow(img, (w * 0.5, h * 1.12), int(w * 0.7), lerp(CYAN, (255, 255, 255), 0.72), 0.5, light)
        glow(img, (w * 0.12, h * -0.1), int(w * 0.45), lerp(VIOLET, (255, 255, 255), 0.78), 0.45, light)
    else:
        img = vertical(SIZE, lerp(DARK_BASE, DARK_LIFT, 0.55), DARK_BASE)
        glow(img, (w * 0.5, h * 1.1), int(w * 0.72), lerp(CYAN, DARK_BASE, 0.3), 0.5, light)
        glow(img, (w * 0.14, h * -0.08), int(w * 0.42), lerp(VIOLET, DARK_BASE, 0.3), 0.45, light)
    return grain(img)


# ---------------------------------------------------------------------------
# Aurora - wide ribbons of light, the way the name promises.
# ---------------------------------------------------------------------------
def build_aurora(light: bool) -> Image.Image:
    w, h = SIZE
    base = (vertical(SIZE, LIGHT_LIFT, lerp(LIGHT_BASE, (216, 224, 236), 0.75)) if light
            else vertical(SIZE, lerp(DARK_BASE, DARK_LIFT, 0.8), DARK_BASE))

    ribbons = Image.new("RGB", SIZE, (0, 0, 0))
    mask = Image.new("L", SIZE, 0)
    md = ImageDraw.Draw(mask)
    rd = ImageDraw.Draw(ribbons)

    bands = [
        (VIOLET, 0.16, 190, 0.9),
        (CYAN, 0.42, 150, 1.25),
        (GOLD, 0.68, 110, 0.8),
        (ROSE, 0.86, 90, 1.05),
    ]
    for colour, y0, thickness, freq in bands:
        pts_top, pts_bottom = [], []
        for x in range(0, w + 24, 24):
            t = x / w
            wave = math.sin(t * math.pi * freq * 2 + y0 * 9) * h * 0.075
            wave += math.sin(t * math.pi * freq * 5.5 + y0 * 3) * h * 0.022
            y = h * y0 + wave
            pts_top.append((x, y - thickness / 2))
            pts_bottom.append((x, y + thickness / 2))
        poly = pts_top + list(reversed(pts_bottom))
        rd.polygon(poly, fill=colour)
        md.polygon(poly, fill=210 if not light else 150)

    mask = mask.filter(ImageFilter.GaussianBlur(85))
    ribbons = ribbons.filter(ImageFilter.GaussianBlur(70))
    img = Image.composite(ribbons, base, mask)
    img = Image.blend(base, img, 0.72 if not light else 0.5)

    glow(img, (w * 0.2, h * 0.05), int(w * 0.4),
         lerp(VIOLET, (255, 255, 255) if light else DARK_BASE, 0.2), 0.45, light)
    glow(img, (w * 0.85, h * 0.12), int(w * 0.35),
         lerp(CYAN, (255, 255, 255) if light else DARK_BASE, 0.2), 0.4, light)
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


def main() -> int:
    builders = {"deep": build_deep, "aurora": build_aurora, "mesh": build_mesh}
    for name, fn in builders.items():
        for light in (False, True):
            img = fn(light)
            out = HERE / f"bg-{name}-{'light' if light else 'dark'}.jpg"
            img.save(out, format="JPEG", quality=88, optimize=True, progressive=True)
            print(f"  {out.name:24} {out.stat().st_size / 1024:6.0f} KB")
    print(f"\nWallpapers written to {HERE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
