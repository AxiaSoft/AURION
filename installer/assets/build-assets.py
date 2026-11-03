#!/usr/bin/env python3
"""Generate the AURION MSI branding assets from the application's own artwork.

Source of truth for the visual identity (never invent new brand colours here):

    apps/web/icons/mark.png      the AURION monogram  (cyan -> blue, gold flame)
    apps/web/assets/login-orb.png  the desk login backdrop
    apps/web/fonts/outfit-*.woff2  the desk Latin typeface
    apps/web/css/app.css           --bg #06070b, --cyan #3ee0c4, --violet #7c6cff

Outputs (checked into installer/assets/generated so a Windows build machine
never needs Python or Pillow just to compile the MSI):

    aurion.ico        multi-resolution product icon (16 -> 256)
    banner.bmp        493 x 58   top banner for every wizard page
    dialog.bmp        493 x 312  welcome / completion hero image
    up.ico new.ico exclamation.ico info.ico   branded wizard glyphs

Windows Installer only renders 24-bit BMPs, so everything is flattened onto
the brand background colour -- no alpha survives.

Usage:  python installer/assets/build-assets.py [--out DIR]
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:  # pragma: no cover
    # --verify is a byte-level check and needs nothing installed; only the
    # generators need Pillow, so the failure is deferred until one is asked
    # for. A build machine must be able to validate what is committed.
    Image = ImageDraw = ImageFilter = ImageFont = None

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "apps" / "web"

# --- brand tokens, copied from apps/web/css/app.css -------------------------
BG = (6, 7, 11)  # --bg      #06070b
INK = (232, 237, 247)  # --ink     #e8edf7
MUTED = (139, 147, 167)  # --muted   #8b93a7
CYAN = (62, 224, 196)  # --cyan    #3ee0c4
VIOLET = (124, 108, 255)  # --violet  #7c6cff
GOLD = (232, 192, 122)  # --gold    #e8c07a

# Windows Installer draws dialog text in the system window-text colour (black)
# and offers no way to recolour a CheckBox or PushButton label. Any area the
# installer writes into therefore has to be a LIGHT surface - the brand's dark
# palette is kept for the artwork columns only.
PAPER_TOP = (250, 251, 253)
PAPER_BOTTOM = (234, 239, 246)

BANNER_SIZE = (493, 58)
DIALOG_SIZE = (493, 312)
ICON_SIZES = (256, 128, 64, 48, 32, 24, 16)


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def load_font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    """Load the desk's own Outfit typeface, converting woff2 -> ttf in memory."""
    names = {
        "regular": "outfit-latin.woff2",
        "medium": "outfit-latin-500.woff2",
        "semibold": "outfit-latin-600.woff2",
    }
    path = WEB / "fonts" / names.get(weight, names["regular"])
    try:
        from fontTools.ttLib import TTFont

        buf = io.BytesIO()
        TTFont(str(path), fontNumber=0).save(buf)
        buf.seek(0)
        return ImageFont.truetype(buf, size)
    except Exception:
        try:
            return ImageFont.truetype("DejaVuSans.ttf", size)
        except Exception:
            return ImageFont.load_default()


def mark(size: int) -> Image.Image:
    """The AURION monogram, cropped tight and background-keyed to transparent."""
    src = Image.open(WEB / "icons" / "mark.png").convert("RGB")
    # The artwork sits on near-black; key it out so the mark can be composited
    # onto the installer's own gradient without a visible black box.
    alpha = src.convert("L").point(lambda v: 0 if v < 26 else min(255, (v - 26) * 4))
    rgba = src.convert("RGBA")
    rgba.putalpha(alpha)
    bbox = rgba.getbbox()
    if bbox:
        rgba = rgba.crop(bbox)
    return rgba.resize((size, size), Image.LANCZOS)


def vertical_wash(size: tuple[int, int], top: tuple[int, int, int],
                  bottom: tuple[int, int, int]) -> Image.Image:
    w, h = size
    grad = Image.new("RGB", (1, h))
    px = grad.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return grad.resize(size, Image.BICUBIC)


def glow(canvas: Image.Image, centre: tuple[int, int], radius: int,
         colour: tuple[int, int, int], strength: float) -> None:
    """Additive radial bloom -- the same liquid-glass feel as the desk."""
    layer = Image.new("RGB", canvas.size, (0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y = centre
    d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=colour)
    layer = layer.filter(ImageFilter.GaussianBlur(radius * 0.62))
    base = canvas.load()
    bloom = layer.load()
    w, h = canvas.size
    for yy in range(h):
        for xx in range(w):
            br, bg_, bb = bloom[xx, yy]
            if br or bg_ or bb:
                r, g, b = base[xx, yy]
                base[xx, yy] = (
                    min(255, r + int(br * strength)),
                    min(255, g + int(bg_ * strength)),
                    min(255, b + int(bb * strength)),
                )


def hairline(draw: ImageDraw.ImageDraw, box, colour, alpha: float) -> None:
    draw.line(box, fill=tuple(round(BG[i] + (colour[i] - BG[i]) * alpha) for i in range(3)))


# ---------------------------------------------------------------------------
# banner  (493 x 58) -- MSI paints its own title text over the LEFT side,
# so the artwork must live on the right and stay quiet.
# ---------------------------------------------------------------------------
def build_banner() -> Image.Image:
    """Top banner. MSI writes the page title over the LEFT side, so that part
    is a light surface; the brand block sits on the right."""
    w, h = BANNER_SIZE
    brand = 168                      # width of the dark brand block, right-aligned
    split = w - brand

    img = vertical_wash(BANNER_SIZE, PAPER_TOP, PAPER_BOTTOM)

    block = vertical_wash((brand, h), (13, 15, 22), BG)
    glow(block, (brand - 54, h // 2), 46, CYAN, 0.16)
    glow(block, (brand - 132, h + 8), 40, VIOLET, 0.07)
    logo = mark(40)
    block.paste(logo, (brand - 52, (h - 40) // 2), logo)
    bd = ImageDraw.Draw(block)
    bd.text((brand - 150, 14), "AURION", font=load_font("semibold", 17), fill=INK)
    bd.text((brand - 149, 34), "by AxiaSoft", font=load_font("regular", 10), fill=MUTED)
    img.paste(block, (split, 0))

    d = ImageDraw.Draw(img)
    hairline(d, (split, 0, split, h), CYAN, 0.35)
    hairline(d, (0, h - 1, w, h - 1), CYAN, 0.30)
    return img


# ---------------------------------------------------------------------------
# dialog  (493 x 312) -- MSI paints the welcome/exit text over the RIGHT side,
# so the hero artwork occupies the left 164 px column.
# ---------------------------------------------------------------------------
def build_dialog() -> Image.Image:
    w, h = DIALOG_SIZE
    panel = 164

    img = vertical_wash(DIALOG_SIZE, (10, 12, 18), (4, 5, 9))

    # Reuse the desk's own login orb as a faint backdrop inside the panel.
    orb_src = WEB / "assets" / "login-orb.png"
    if orb_src.exists():
        orb = Image.open(orb_src).convert("RGB")
        scale = max(panel / orb.width, h / orb.height) * 1.25
        orb = orb.resize((int(orb.width * scale), int(orb.height * scale)), Image.LANCZOS)
        left = max(0, (orb.width - panel) // 2)
        top = max(0, (orb.height - h) // 2)
        orb = orb.crop((left, top, left + panel, top + h))
        orb = Image.blend(Image.new("RGB", (panel, h), BG), orb, 0.55)
        # Fade the backdrop out under the wordmark so the type stays legible.
        scrim = orb.load()
        for y in range(h):
            if y <= 168:
                continue
            k = min(1.0, (y - 168) / 70.0) * 0.88
            for x in range(panel):
                r, g, b = scrim[x, y]
                scrim[x, y] = tuple(round(c + (BG[i] - c) * k) for i, c in enumerate((r, g, b)))
        img.paste(orb, (0, 0))

    glow(img, (panel // 2, 116), 96, CYAN, 0.13)
    glow(img, (panel // 2 + 14, 268), 86, VIOLET, 0.09)

    logo = mark(96)
    img.paste(logo, ((panel - 96) // 2, 78), logo)

    d = ImageDraw.Draw(img)
    title = load_font("semibold", 22)
    tw = d.textlength("AURION", font=title)
    d.text(((panel - tw) / 2, 186), "AURION", font=title, fill=INK)

    sub = load_font("regular", 11)
    for i, line in enumerate(("Live execution", "for MetaTrader 5")):
        lw = d.textlength(line, font=sub)
        d.text(((panel - lw) / 2, 214 + i * 15), line, font=sub, fill=MUTED)

    tag = load_font("medium", 9)
    tagw = d.textlength("AXIASOFT", font=tag)
    d.text(((panel - tagw) / 2, h - 30), "AXIASOFT", font=tag, fill=GOLD)

    # The column MSI writes into must be light: welcome/finish body text and
    # the "Start AURION now" checkbox are painted by Windows in black, and a
    # CheckBox label cannot be recoloured from the authoring at all.
    paper = vertical_wash((w - panel, h), PAPER_TOP, PAPER_BOTTOM)
    glow(paper, (w - panel - 40, h - 30), 150, CYAN, 0.05)
    glow(paper, (30, 40), 130, VIOLET, 0.04)
    img.paste(paper, (panel, 0))

    d = ImageDraw.Draw(img)
    # Divider between the artwork column and the text column.
    for x, a in ((panel - 1, 0.42), (panel, 0.12)):
        hairline(d, (x, 0, x, h), CYAN, a)
    return img


# ---------------------------------------------------------------------------
# icons
# ---------------------------------------------------------------------------
def build_icon(out: Path) -> None:
    """The product icon: the AURION logo, unaltered, at every size Windows asks for.

    Two things are deliberate.

    The background is solid black rather than transparent. The logo's own
    file has a transparent background - it only looks black in a viewer -
    and the wordmark is silver, so a transparent icon over a light Explorer
    window shows the mark and loses the word underneath it. Black is also
    how the logo was supplied.

    Nothing is cropped or substituted at the small sizes. The whole lockup
    is used at 16 and 24 as well, where the word AURION is a smudge; that is
    the brand as given, and the alternative - dropping the wordmark below
    48px - is a decision for whoever owns the brand, not for this script.
    """
    source = WEB / "icons" / "mark.png"
    art = Image.open(source).convert("RGBA")

    frames = []
    for size in sorted(ICON_SIZES, reverse=True):
        tile = Image.new("RGBA", (size, size), (0, 0, 0, 255))
        scaled = art.resize((size, size), Image.LANCZOS)
        tile.alpha_composite(scaled)
        frames.append(tile)

    frames[0].save(out, format="ICO", sizes=[(f.width, f.height) for f in frames],
                   append_images=frames[1:])


def build_glyph(out: Path, kind: str) -> None:
    """Small branded wizard glyphs replacing the stock yellow WiX icons."""
    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    accent = {"exclamation": GOLD, "info": CYAN, "new": CYAN, "up": VIOLET}[kind]
    d.ellipse((2, 2, size - 3, size - 3), fill=BG + (255,), outline=accent + (255,), width=3)
    if kind == "exclamation":
        d.rounded_rectangle((29, 16, 35, 40), 3, fill=accent + (255,))
        d.ellipse((28, 45, 36, 53), fill=accent + (255,))
    elif kind == "info":
        d.ellipse((28, 13, 36, 21), fill=accent + (255,))
        d.rounded_rectangle((29, 26, 35, 50), 3, fill=accent + (255,))
    elif kind == "new":
        d.rounded_rectangle((20, 29, 44, 35), 3, fill=accent + (255,))
        d.rounded_rectangle((29, 20, 35, 44), 3, fill=accent + (255,))
    else:  # up
        d.polygon([(32, 17), (46, 34), (38, 34), (38, 47), (26, 47), (26, 34), (18, 34)],
                  fill=accent + (255,))
    img.save(out, format="ICO", sizes=[(16, 16), (32, 32), (48, 48), (64, 64)])


# ---------------------------------------------------------------------------
# verification
# ---------------------------------------------------------------------------
# An asset with the right name and the wrong contents is the worst kind of
# broken: every existence check passes and the failure surfaces a minute
# later, from the C# compiler, as
#
#     CSC : error CS7065: Error building Win32 resources --
#           Icon stream is not in the expected format.
#
# which says nothing about which file or why. That is exactly what happened
# when aurion.ico was replaced with a PNG that had been renamed: a valid
# picture, in a container Windows cannot read. This check is bytes only, so
# it runs anywhere, and it names the file and the fix.

EXPECTED = {
    "aurion.ico": "ico",
    "exclamation.ico": "ico",
    "info.ico": "ico",
    "new.ico": "ico",
    "up.ico": "ico",
    "banner.bmp": "bmp",
    "dialog.bmp": "bmp",
}


def describe(blob: bytes) -> str:
    """What this file actually is, by its magic number."""
    if blob[:4] == b"\x89PNG":
        return "a PNG"
    if blob[:2] == b"\xff\xd8":
        return "a JPEG"
    if blob[:2] == b"BM":
        return "a BMP"
    if blob[:4] == b"\x00\x00\x01\x00":
        return "an ICO"
    if blob[:4] == b"\x00\x00\x02\x00":
        return "a CUR (cursor), not an icon"
    if blob[:4] == b"RIFF":
        return "a WebP or RIFF container"
    if blob[:5] == b"<?xml" or blob[:4] == b"<svg":
        return "an SVG"
    return "of an unrecognised format"


def verify_ico(path: Path, blob: bytes) -> list[str]:
    bad: list[str] = []
    if blob[:4] != b"\x00\x00\x01\x00":
        bad.append(f"{path.name} is {describe(blob)}, not an icon container")
        return bad
    if len(blob) < 22:
        bad.append(f"{path.name} is too short to hold a directory entry")
        return bad
    count = int.from_bytes(blob[4:6], "little")
    if count < 1:
        bad.append(f"{path.name} declares no images")
        return bad
    for i in range(count):
        off = 6 + i * 16
        if off + 16 > len(blob):
            bad.append(f"{path.name}: directory entry {i + 1} runs past the end of the file")
            break
        size = int.from_bytes(blob[off + 8:off + 12], "little")
        data = int.from_bytes(blob[off + 12:off + 16], "little")
        if data + size > len(blob):
            bad.append(f"{path.name}: image {i + 1} points outside the file")
    return bad


def verify(out: Path) -> int:
    problems: list[str] = []
    for name, kind in sorted(EXPECTED.items()):
        path = out / name
        if not path.exists():
            problems.append(f"{name} is missing")
            continue
        blob = path.read_bytes()
        if kind == "ico":
            problems.extend(verify_ico(path, blob))
        elif blob[:2] != b"BM":
            problems.append(f"{name} is {describe(blob)}, not a BMP")
        else:
            print(f"  {name:<18} ok")
            continue
        if not problems or not problems[-1].startswith(name):
            print(f"  {name:<18} ok")
    if problems:
        print("\nThese branding assets cannot be used:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(
            "\nAn icon has to be a real .ico container. Renaming a .png to .ico\n"
            "produces a file Windows and the C# compiler both refuse.\n"
            "  restore the committed ones:  git checkout -- installer/assets/generated\n"
            "  or rebuild them:             python installer/assets/build-assets.py\n"
            "  to convert your own artwork: magick logo.png -define icon:auto-resize=256,128,64,48,32,24,16 aurion.ico",
            file=sys.stderr,
        )
        return 1
    print("\nEvery branding asset is the format its name claims.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Build AURION MSI branding assets")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "generated"))
    ap.add_argument("--verify", action="store_true",
                    help="check the committed assets are the formats they claim, and build nothing")
    args = ap.parse_args()

    out = Path(args.out)
    if args.verify:
        return verify(out)
    if Image is None:
        sys.exit("Pillow is required to build assets:  pip install Pillow fonttools brotli")
    out.mkdir(parents=True, exist_ok=True)

    build_banner().save(out / "banner.bmp", format="BMP")
    build_dialog().save(out / "dialog.bmp", format="BMP")
    build_icon(out / "aurion.ico")
    for kind in ("exclamation", "info", "new", "up"):
        build_glyph(out / f"{kind}.ico", kind)

    for f in sorted(out.iterdir()):
        print(f"  {f.name:<18} {f.stat().st_size / 1024:8.1f} KB")
    print(f"\nAssets written to {out}")
    # Never hand back something the compiler will reject.
    return verify(out)


if __name__ == "__main__":
    raise SystemExit(main())
