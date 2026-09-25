#!/usr/bin/env python3
"""Regenerate the MSI wizard branding assets (banner + small icon).

Requires ImageMagick (``convert``) on PATH. Output:
  windows-app/packaging/wix/banner.bmp        493x58 wizard banner (WixUI_Banner)
  windows-app/packaging/wix/aurion-small.ico  16/32/48/64 wizard icon
  windows-app/packaging/wix/banner-preview.png 3x preview for review

Sources (already committed to the repo):
  apps/web/icons/mark.png                      the AURION "Au" + flame mark
  apps/web/assets/login-orb-light.png          aurora orb (used for the glow)

Optional: a DejaVu TTF for the text ("AURION" + tagline). Any TTF path can be
passed with --font; without it the banner is built without text.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
OUT = HERE / "wix"

MARK = ROOT / "apps" / "web" / "icons" / "mark.png"
ORB = ROOT / "apps" / "web" / "assets" / "login-orb-light.png"


def run(*args: str) -> None:
    print("+", " ".join(str(a) for a in args))
    subprocess.check_call([str(a) for a in args])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--font", type=Path, default=None,
                    help="TTF font for the banner text (DejaVu Sans bold)")
    ap.add_argument("--font-tagline", type=Path, default=None,
                    help="TTF font for the tagline (DejaVu Sans regular)")
    args = ap.parse_args()

    if not shutil.which("convert"):
        print("ImageMagick 'convert' not found - skipping asset generation.")
        print("The committed assets in windows-app/packaging/wix/ are used as-is.")
        return
    if not MARK.exists() or not ORB.exists():
        print(f"Missing sources: {MARK} / {ORB}")
        return

    OUT.mkdir(parents=True, exist_ok=True)
    tmp = OUT / "tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir()

    # 1) The Au+flame glyph, black made transparent (crop excludes the tilted
    #    AURION wordmark baked into the mark image).
    glyph = tmp / "glyph.png"
    run("convert", str(MARK), "-crop", "860x1230+790+250", "+repage",
        "-fuzz", "18%", "-transparent", "black", "-trim", "+repage", str(glyph))

    # 2) Banner base. WixUI paints the page title + description in BLACK
    #    over the left ~330px of the banner, so that area must stay light and
    #    empty; the branding lives in the right corner only.
    base = tmp / "base.png"
    run("convert", "-size", "493x58", "gradient:#FFFFFF-#EAF0F6", "-rotate", "90",
        "-resize", "493x58!", str(base))
    # right-side navy block with a soft diagonal fade into the light area
    navy = tmp / "navy.png"
    run("convert", "-size", "170x58", "gradient:#0B1725-#142C46", "-rotate", "90",
        "-resize", "170x58!", str(navy))
    mask = tmp / "mask.png"
    run("convert", "-size", "170x58", "gradient:white-black", "-rotate", "90",
        "-resize", "170x58!", "-level", "0%,60%", str(mask))
    run("convert", str(navy), str(mask), "-alpha", "off", "-compose", "CopyOpacity",
        "-composite", str(tmp / "navy-a.png"))
    run("convert", str(base), str(tmp / "navy-a.png"), "-geometry", "+323+0",
        "-compose", "Over", "-composite", str(tmp / "s1.png"))
    b = tmp / "s1.png"

    # 3) Aurora glow + mark + wordmark, all inside the right 150px.
    glow = tmp / "glow.png"
    run("convert", "-size", "160x160",
        "radial-gradient:rgba(42,157,143,0.55)-rgba(42,157,143,0)", str(glow))
    run("convert", str(b), str(glow), "-geometry", "+400-50", "-composite",
        str(tmp / "s2.png"))
    b = tmp / "s2.png"
    glyph40 = tmp / "glyph40.png"
    run("convert", str(glyph), "-resize", "40x40", str(glyph40))
    run("convert", str(b), str(glyph40), "-geometry", "+446+9", "-composite",
        str(tmp / "s3.png"))
    b = tmp / "s3.png"
    tagline_font = args.font_tagline or args.font
    if args.font:
        run("convert", str(b), "-font", args.font, "-pointsize", "15",
            "-fill", "#FFFFFF", "-annotate", "+370+28", "AURION",
            str(tmp / "s4.png"))
        b = tmp / "s4.png"
        run("convert", str(b), "-font", tagline_font, "-pointsize", "8",
            "-fill", "#93A7C4", "-annotate", "+370+42", "Live MT5 Desk",
            str(tmp / "s5.png"))
        b = tmp / "s5.png"

    # 4) Final banner (24-bit BMP, the WixUI_Banner format).
    run("convert", str(b), "-type", "TrueColor", "BMP3:" + str(OUT / "banner.bmp"))
    run("convert", str(b), "-resize", "1479x174", str(OUT / "banner-preview.png"))

    # 4b) Dialog side bitmap (493x312, WixUIDialogBmp): left 164px column with
    #     the mark on the navy gradient - shown on Welcome/Finish pages.
    dbase = tmp / "dbase.png"
    run("convert", "-size", "493x312", "xc:#FFFFFF", "-type", "TrueColor", "PNG24:" + str(dbase))
    dcol = tmp / "dcol.png"
    run("convert", "-size", "164x312", "gradient:#0B1725-#142C46", "-colorspace", "sRGB", "-type", "TrueColor", "PNG24:" + str(dcol))
    dglow = tmp / "dglow.png"
    run("convert", "-size", "240x240",
        "radial-gradient:rgba(42,157,143,0.55)-rgba(42,157,143,0)", str(dglow))
    run("convert", str(dcol), str(dglow), "-geometry", "-40+180", "-composite", "-type", "TrueColor", "PNG24:" + str(tmp / "d1.png"))
    glyph96 = tmp / "glyph96.png"
    run("convert", str(glyph), "-resize", "96x96", str(glyph96))
    run("convert", str(tmp / "d1.png"), str(glyph96), "-gravity", "north", "-geometry", "+0+40",
        "-composite", str(tmp / "d2.png"))
    d = tmp / "d2.png"
    if args.font:
        run("convert", str(d), "-gravity", "north", "-font", args.font, "-pointsize", "22",
            "-fill", "#FFFFFF", "-annotate", "+0+150", "AURION", str(tmp / "d3.png"))
        d = tmp / "d3.png"
        run("convert", str(d), "-gravity", "north", "-font", tagline_font, "-pointsize", "11",
            "-fill", "#93A7C4", "-annotate", "+0+180", "Live MT5 Desk", str(tmp / "d4.png"))
        d = tmp / "d4.png"
    run("convert", str(d), "-background", "#FFFFFF", "-gravity", "west", "-extent", "493x312",
        "-type", "TrueColor", "-define", "bmp:format=bmp3", "BMP3:" + str(OUT / "dialog.bmp"))

    # 5) Small wizard icon (16/32/48/64) from the mark on a black square.
    sq = tmp / "glyph-sq.png"
    run("convert", str(MARK), "-crop", "860x1230+790+250", "+repage", "-trim",
        "+repage", "-gravity", "center", "-background", "black",
        "-extent", "1230x1230", str(sq))
    sizes = []
    for s in (64, 48, 32, 16):
        p = tmp / f"g{s}.png"
        run("convert", str(sq), "-resize", f"{s}x{s}", str(p))
        sizes.append(p)
    run("convert", *sizes, str(OUT / "aurion-small.ico"))

    shutil.rmtree(tmp)
    print(f"Assets written to {OUT}/")
    print("Banner preview: wix/banner-preview.png")


if __name__ == "__main__":
    main()
